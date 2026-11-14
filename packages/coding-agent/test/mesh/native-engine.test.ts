import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { InstanceHost, MeshNode, type MeshPeerInfo } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MeshEngineError, type MeshPeerView } from "../../src/mesh/engine";
import { NativeMeshEngine } from "../../src/mesh/native-engine";
import type { MeshSnapshot } from "../../src/mesh/wire";
import { meshSnapshot } from "./scripted-engine";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function snapshotOf(engine: NativeMeshEngine, displayName: string): MeshSnapshot {
	return meshSnapshot({
		instanceId: engine.instanceId,
		displayName,
		pid: process.pid,
		sessionName: `${displayName} session`,
		startedAt: Date.now(),
	});
}

/** Two engines on their own instance hosts in one private registry, configured `local`, each serving a snapshot. */
async function pair(): Promise<[NativeMeshEngine, NativeMeshEngine]> {
	const registryDir = TempDir.createSync("@pi-mesh-engine-");
	cleanups.push(() => registryDir.removeSync());
	const hostA = new InstanceHost({ dir: registryDir.path() });
	const hostB = new InstanceHost({ dir: registryDir.path() });
	cleanups.push(() => hostA.close());
	cleanups.push(() => hostB.close());
	const a = new NativeMeshEngine({ host: hostA, hostName: "box" });
	const b = new NativeMeshEngine({ host: hostB, hostName: "box" });
	expect(a.instanceId).toBe(hostA.instanceId);
	cleanups.push(() => a.close());
	cleanups.push(() => b.close());
	a.setSnapshot(snapshotOf(a, "alice"));
	b.setSnapshot(snapshotOf(b, "bob"));
	const config = { mode: "local" as const, lanPort: 0, staticPeers: [], deniedKinds: [] };
	expect((await a.configure({ ...config, displayName: "alice" })).local).toBe("on");
	expect((await b.configure({ ...config, displayName: "bob" })).local).toBe("on");
	await peerWhere(a, b.instanceId, peer => peer.snapshot !== null);
	return [a, b];
}

/** Resolves once `engine`'s view of `peerId` satisfies `ready`, refreshing discovery to get there. */
async function peerWhere(
	engine: NativeMeshEngine,
	peerId: string,
	ready: (peer: MeshPeerView) => boolean,
): Promise<MeshPeerView> {
	const { promise, resolve } = Promise.withResolvers<MeshPeerView>();
	const check = () => {
		const peer = engine.peers().find(candidate => candidate.instanceId === peerId);
		if (peer && ready(peer)) resolve(peer);
	};
	const unsubscribe = engine.onPeersChanged(check);
	engine.refresh();
	check();
	try {
		return await promise;
	} finally {
		unsubscribe();
	}
}

describe("NativeMeshEngine", () => {
	it("reuses a peer's parsed snapshot until the peer publishes a new one", async () => {
		const [a, b] = await pair();
		const first = a.peers().find(peer => peer.instanceId === b.instanceId);
		expect(first?.endpoint).toEqual({ kind: "local" });
		expect(first?.snapshot?.displayName).toBe("bob");
		expect(first?.snapshot?.sessionName).toBe("bob session");
		expect(a.peers().find(peer => peer.instanceId === b.instanceId)?.snapshot).toBe(first?.snapshot!);

		b.setSnapshot(snapshotOf(b, "robert"));
		const updated = await peerWhere(a, b.instanceId, peer => peer.snapshot?.displayName === "robert");
		expect(updated.snapshot).not.toBe(first?.snapshot!);
		expect(a.peers().find(peer => peer.instanceId === b.instanceId)?.snapshot).toBe(updated.snapshot!);

		// Flags reach the right fields (hidden and blocked are not swapped on the way to the engine).
		a.setPeerFlags(b.instanceId, { hidden: true });
		const flagged = a.peers().find(peer => peer.instanceId === b.instanceId);
		expect([flagged?.hidden, flagged?.blocked]).toEqual([true, false]);
	});

	describe("incremental peer snapshots", () => {
		/** Passes `MeshNode.peers` through `rewrite`, recording each call's `sinceRevision` and result. */
		function spyPeers(rewrite: (since: number | undefined, infos: MeshPeerInfo[]) => MeshPeerInfo[]) {
			const original = MeshNode.prototype.peers;
			const spy = spyOn(MeshNode.prototype, "peers").mockImplementation(function (this: MeshNode, since) {
				const infos = original.call(this, since);
				return rewrite(since ?? undefined, infos);
			});
			cleanups.push(() => spy.mockRestore());
			return spy;
		}
		const withoutSnapshots = (infos: MeshPeerInfo[]) => infos.map(info => ({ ...info, snapshotJson: undefined }));

		it("reads every snapshot again when a newer one did not come with its peer", async () => {
			const [a, b] = await pair();
			// The engine "forgets" to attach any snapshot to an incremental read.
			const spy = spyPeers((since, infos) => (since ? withoutSnapshots(infos) : infos));

			b.setSnapshot(snapshotOf(b, "robert"));
			const updated = await peerWhere(a, b.instanceId, peer => peer.snapshot?.displayName === "robert");
			expect(updated.snapshot?.displayName).toBe("robert");

			const calls = spy.mock.calls.map(call => call[0]);
			const full = calls.indexOf(0);
			expect(full).toBeGreaterThan(0);
			expect(calls[full - 1]).toBeGreaterThan(0);

			// The full read advanced the watermark to the new revision.
			const refreshed = (spy.mock.results[full]!.value as MeshPeerInfo[]).find(
				info => info.instanceId === b.instanceId,
			)!;
			const before = calls.length;
			expect(a.peers().find(peer => peer.instanceId === b.instanceId)?.snapshot?.displayName).toBe("robert");
			expect(spy.mock.calls.slice(before).map(call => call[0])).toEqual([refreshed.snapshotRevision]);
		});
	});

	it("answers inbound requests from the handler and maps failures", async () => {
		const [a, b] = await pair();
		const body = { op: "threads" } as const;

		expect(await a.request(b.instanceId, "Main", body)).toMatchObject({ ok: false, code: "unsupported" });

		const detach = b.setInboundHandler(async request => {
			expect(request.envelope.from.instanceId).toBe(a.instanceId);
			expect(request.origin.kind).toBe("local");
			return { ok: true, data: { echoed: request.envelope.body } };
		});
		expect(await a.request(b.instanceId, "Main", body)).toEqual({ ok: true, data: { echoed: body } });

		detach();
		b.setInboundHandler(async () => {
			throw new Error("boom");
		});
		expect(await a.request(b.instanceId, "Main", body)).toMatchObject({ ok: false, code: "internal" });
	});

	it("tracks answers under the ticket: held for the coming wait, then delivered as reply events", async () => {
		const [a, b] = await pair();
		b.setInboundHandler(async request => {
			const { body, msgId } = request.envelope;
			return body.op === "message"
				? { ok: true, data: { accepted: true, msgId, thread: "t1" } }
				: { ok: true, data: { accepted: true } };
		});
		const replied = Promise.withResolvers<{ ticket: string; text: string }>();
		a.onReply((ticket, reply) => replied.resolve({ ticket, text: reply.op === "reply" ? reply.text : "" }));

		const ack = await a.request(
			b.instanceId,
			"Main",
			{ op: "message", kind: "ask", text: "q" },
			{ ticket: "t-1", hold: true },
		);
		if (!ack.ok) throw new Error(ack.message);
		const { msgId } = ack.data as { msgId: string };
		const answer = (text: string) => b.request(a.instanceId, "Main", { op: "reply", replyTo: msgId, text });

		expect(await answer("first")).toMatchObject({ ok: true });
		expect(await a.awaitReply(msgId, 5_000)).toMatchObject({
			op: "reply",
			text: "first",
			from: { instanceId: b.instanceId },
		});
		expect(await answer("second")).toMatchObject({ ok: true });
		expect(await replied.promise).toEqual({ ticket: "t-1", text: "second" });
	});

	it("rejects transport failures with coded MeshEngineErrors", async () => {
		const [a, b] = await pair();
		const unknown = await a
			.request("zzzzzzzzzzzzzzzz", "Main", { op: "snapshot" }, { timeoutMs: 1000 })
			.catch(e => e);
		expect(unknown).toBeInstanceOf(MeshEngineError);
		expect((unknown as MeshEngineError).code).toBe("unreachable");

		const controller = new AbortController();
		const pending = a.request(b.instanceId, "Main", { op: "threads" }, { signal: controller.signal });
		controller.abort();
		const aborted = await pending.catch(e => e);
		expect(aborted).toBeInstanceOf(MeshEngineError);
		expect((aborted as MeshEngineError).code).toBe("aborted");
	});

	it("reports a rejected configuration as status error until one succeeds", async () => {
		const [a] = await pair();
		const statuses: (string | undefined)[] = [];
		a.onStatusChanged(status => statuses.push(status.error));
		const bad = await a.configure({
			mode: "local",
			lanPort: 70_000,
			staticPeers: [],
			displayName: "alice",
			deniedKinds: [],
		});
		expect(bad.error).toStartWith("Invalid mesh configuration:");
		expect(a.status().error).toBe(bad.error);
		const good = await a.configure({
			mode: "local",
			lanPort: 0,
			staticPeers: [],
			displayName: "alice",
			deniedKinds: [],
		});
		expect(good.error).toBeUndefined();
		expect(statuses).toContain(bad.error);
		expect(statuses).toContain(undefined);
	});

	it("resolves a malformed request body to bad_request instead of rejecting", async () => {
		const [a, b] = await pair();
		const response = await a.request(b.instanceId, "Main", { op: "bogus" } as never);
		expect(response.ok).toBe(false);
		if (response.ok) return;
		expect(response.code).toBe("bad_request");
		expect(response.message).toStartWith("malformed mesh request:");
	});
});
