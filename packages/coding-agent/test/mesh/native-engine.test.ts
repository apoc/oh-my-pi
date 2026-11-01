import { afterEach, describe, expect, it } from "bun:test";
import { InstanceHost } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MeshEngineError } from "../../src/mesh/engine";
import { NativeMeshEngine } from "../../src/mesh/native-engine";
import type { MeshSnapshot } from "../../src/mesh/wire";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function snapshotOf(engine: NativeMeshEngine, displayName: string): MeshSnapshot {
	return {
		instanceId: engine.instanceId,
		displayName,
		host: "box",
		pid: process.pid,
		ompVersion: "0.0.0",
		protocol: 1,
		sessionId: "s-1",
		sessionName: `${displayName} session`,
		summary: null,
		cwd: "/repo",
		repo: null,
		model: null,
		busy: false,
		agents: [],
		startedAt: Date.now(),
	};
}

/** Two engines on their own instance hosts in one private registry, configured `local`, each serving a snapshot. */
async function pair(): Promise<[NativeMeshEngine, NativeMeshEngine]> {
	const registryDir = TempDir.createSync("@pi-mesh-engine-");
	cleanups.push(() => registryDir.removeSync());
	const hostA = new InstanceHost({ dir: registryDir.path() });
	const hostB = new InstanceHost({ dir: registryDir.path() });
	cleanups.push(() => hostA.close());
	cleanups.push(() => hostB.close());
	const a = new NativeMeshEngine({ host: hostA, displayName: "alice", hostName: "box" });
	const b = new NativeMeshEngine({ host: hostB, displayName: "bob", hostName: "box" });
	expect(a.instanceId).toBe(hostA.instanceId);
	cleanups.push(() => a.close());
	cleanups.push(() => b.close());
	a.setSnapshot(snapshotOf(a, "alice"));
	b.setSnapshot(snapshotOf(b, "bob"));
	const config = { mode: "local" as const, lanPort: 0, staticPeers: [] };
	expect((await a.configure({ ...config, displayName: "alice" })).local).toBe("on");
	expect((await b.configure({ ...config, displayName: "bob" })).local).toBe("on");
	const { promise: discovered, resolve } = Promise.withResolvers<void>();
	const check = () => {
		if (a.peers().some(peer => peer.instanceId === b.instanceId && peer.snapshot)) resolve();
	};
	const unsubscribe = a.onPeersChanged(check);
	a.refresh();
	check();
	await discovered;
	unsubscribe();
	return [a, b];
}

describe("NativeMeshEngine", () => {
	it("maps peers with parsed snapshots", async () => {
		const [a, b] = await pair();
		const peer = a.peers().find(candidate => candidate.instanceId === b.instanceId);
		expect(peer?.endpoint).toEqual({ kind: "local" });
		expect(peer?.snapshot?.displayName).toBe("bob");
		expect(peer?.snapshot?.sessionName).toBe("bob session");
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

		const bad = await a.request(b.instanceId, "Main", { op: "thread", thread: "../x" });
		expect(bad).toEqual({ ok: false, code: "unknown_thread", message: "Unknown thread ../x." });

		a.forgetPending(["t-1"]);
		expect(await a.awaitReply(msgId, 5_000)).toBeUndefined();
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
		const bad = await a.configure({ mode: "local", lanPort: 70_000, staticPeers: [], displayName: "alice" });
		expect(bad.error).toStartWith("Invalid mesh configuration:");
		expect(a.status().error).toBe(bad.error);
		const good = await a.configure({ mode: "local", lanPort: 0, staticPeers: [], displayName: "alice" });
		expect(good.error).toBeUndefined();
		expect(statuses).toContain(bad.error);
		expect(statuses).toContain(undefined);
	});
});
