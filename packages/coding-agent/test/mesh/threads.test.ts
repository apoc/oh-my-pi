import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	MESH_MAX_THREADS_PER_PEER,
	MESH_MAX_THREADS_TOTAL,
	MESH_MAX_TURNS_PER_THREAD,
	MESH_MAX_UNANSWERED_PER_PEER,
	MESH_MAX_UNANSWERED_TOTAL,
	type MeshThreadHost,
	MeshThreadLimitError,
	type MeshThreadRecord,
	MeshThreadStore,
	meshConversationKey,
} from "../../src/mesh/threads";
import type { MeshSender } from "../../src/mesh/wire";
import { isMeshThreadResponder, meshResponderArtifactsDir } from "../../src/mesh/paths";

const HOUR_MS = 60 * 60 * 1000;
const alice: MeshSender = { instanceId: "inst-alice", agentId: "Main", displayName: "Alice", host: "box-a" };
const bob: MeshSender = { instanceId: "inst-bob", agentId: "Main", displayName: "Bob", host: "box-b" };

class FakeHost implements MeshThreadHost {
	sessionId = "session-1";
	artifactsDir: string | null = null;
	readonly #callbacks = new Set<() => void>();

	getSessionId(): string {
		return this.sessionId;
	}

	getArtifactsDir(): string | null {
		return this.artifactsDir;
	}

	registerSessionChangeCallback(callback: () => void): () => void {
		this.#callbacks.add(callback);
		return () => this.#callbacks.delete(callback);
	}

	switchSession(sessionId: string): void {
		this.sessionId = sessionId;
		for (const callback of this.#callbacks) callback();
	}
}

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("MeshThreadStore", () => {
	it("runs one turn per thread at a time, in arrival order, past failures", async () => {
		const store = new MeshThreadStore(new FakeHost(), { ttlMs: () => HOUR_MS });
		const events: string[] = [];
		const first = Promise.withResolvers<void>();
		const a1 = store.runSerialized("t1", async () => {
			events.push("a1:start");
			await first.promise;
			events.push("a1:end");
		});
		const a2 = store.runSerialized("t1", async () => {
			events.push("a2:start");
			throw new Error("boom");
		});
		const a3 = store.runSerialized("t1", async () => {
			events.push("a3:start");
		});
		// Another thread is not held up by t1.
		await store.runSerialized("t2", async () => {
			events.push("b1");
		});
		expect(events).toEqual(["a1:start", "b1"]);
		first.resolve();
		await a1;
		await expect(a2).rejects.toThrow("boom");
		await a3;
		expect(events).toEqual(["a1:start", "b1", "a1:end", "a2:start", "a3:start"]);
	});

	it("hides a thread from every instance but its asker and expires all threads on session switch", async () => {
		const host = new FakeHost();
		const store = new MeshThreadStore(host, { ttlMs: () => HOUR_MS });
		const record = await store.create("ask", alice, "m1", "what are you doing?");

		expect((await store.lookup(record.threadId, alice.instanceId)).ok).toBe(true);
		expect(await store.lookup(record.threadId, bob.instanceId)).toMatchObject({ ok: false, code: "unknown_thread" });
		expect((await store.list(bob.instanceId)).map(r => r.threadId)).toEqual([]);

		host.switchSession("session-2");
		expect(await store.lookup(record.threadId, alice.instanceId)).toMatchObject({
			ok: false,
			code: "thread_expired",
		});
		// Expiry must not reveal the thread's existence to a different asker.
		expect(await store.lookup(record.threadId, bob.instanceId)).toMatchObject({ ok: false, code: "unknown_thread" });
		// Late writes from a responder that outlived the switch are dropped.
		store.updateTurn(record.threadId, 0, { status: "complete", answer: "late" });
		expect(await store.list(alice.instanceId)).toEqual([]);
	});

	it("expires idle threads past the TTL but never one with a turn in flight", async () => {
		let ttlMs = HOUR_MS;
		const store = new MeshThreadStore(new FakeHost(), { ttlMs: () => ttlMs });
		const busy = await store.create("status", alice, "m1", "q1");
		const idle = await store.create("status", alice, "m2", "q2");
		store.updateTurn(idle.threadId, 0, { status: "complete", answer: "a2" });

		ttlMs = -1;
		expect((await store.lookup(busy.threadId, alice.instanceId)).ok).toBe(true);
		expect(await store.lookup(idle.threadId, alice.instanceId)).toMatchObject({ ok: false, code: "thread_expired" });
	});

	it("reloads a session's threads from disk, marking turns the previous process left unfinished", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-threads-"));
		tempDirs.push(dir);
		const host = new FakeHost();
		host.artifactsDir = dir;
		const store = new MeshThreadStore(host, { ttlMs: () => HOUR_MS });
		const record = await store.create("status", alice, "m1", "q1");
		store.updateTurn(record.threadId, 0, { status: "complete", answer: "a1" });
		store.appendTurn(record.threadId, "m2", "q2");
		store.updateTurn(record.threadId, 1, { status: "running" });
		await store.flush();
		store.dispose();

		const reopened = new MeshThreadStore(host, { ttlMs: () => HOUR_MS });
		const lookup = await reopened.lookup(record.threadId, alice.instanceId);
		if (!lookup.ok) throw new Error(lookup.message);
		expect(lookup.record.turns.map(turn => [turn.answer, turn.status])).toEqual([
			["a1", "complete"],
			[undefined, "interrupted"],
		]);
		// Another session sharing the artifacts directory does not adopt them.
		host.sessionId = "session-other";
		const foreign = new MeshThreadStore(host, { ttlMs: () => HOUR_MS });
		expect(await foreign.lookup(record.threadId, alice.instanceId)).toMatchObject({ code: "unknown_thread" });
	});
});

describe("MeshThreadStore bounds", () => {
	const peerN = (n: number): MeshSender => ({ ...alice, instanceId: `inst-${n}` });
	const refusal = async (attempt: () => unknown): Promise<MeshThreadLimitError> => {
		try {
			await attempt();
		} catch (error) {
			if (error instanceof MeshThreadLimitError) return error;
			throw error;
		}
		throw new Error("expected the store to refuse");
	};
	const files = async (dir: string): Promise<string[]> => fs.readdir(path.join(dir, "mesh-threads")).catch(() => []);

	it("refuses a peer's unanswered question past the per-peer cap, creating no record or file, until one completes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-threads-"));
		tempDirs.push(dir);
		const host = new FakeHost();
		host.artifactsDir = dir;
		const store = new MeshThreadStore(host, { ttlMs: () => HOUR_MS });
		const first = await store.create("ask", alice, "m0", "q0");
		for (let i = 1; i < MESH_MAX_UNANSWERED_PER_PEER; i++) await store.create("ask", alice, `m${i}`, `q${i}`);
		await store.flush();
		const before = await files(dir);
		expect(before).toHaveLength(MESH_MAX_UNANSWERED_PER_PEER);

		expect((await refusal(() => store.create("ask", alice, "mx", "qx"))).code).toBe("busy");
		// A follow-up on an existing thread is an unanswered question too, and leaves the record as it was.
		expect((await refusal(() => store.appendTurn(first.threadId, "mx", "qx"))).code).toBe("busy");
		expect(first.turns).toHaveLength(1);
		await store.flush();
		expect(await files(dir)).toEqual(before);
		expect(await store.list(alice.instanceId)).toHaveLength(MESH_MAX_UNANSWERED_PER_PEER);

		// Another instance is not held up by alice's backlog.
		await store.create("ask", bob, "mb", "qb");
		store.updateTurn(first.threadId, 0, { status: "complete", answer: "a" });
		await store.create("ask", alice, "my", "qy");
	});

	it("refuses past the total cap across peers", async () => {
		const store = new MeshThreadStore(new FakeHost(), { ttlMs: () => HOUR_MS });
		for (let i = 0; i < MESH_MAX_UNANSWERED_TOTAL; i++) await store.create("status", peerN(i), `m${i}`, `q${i}`);
		const refused = await refusal(() => store.create("status", peerN(1000), "mx", "qx"));
		expect(refused.code).toBe("busy");
		expect(await store.list(peerN(1000).instanceId)).toEqual([]);
	});

	it("evicts a peer's oldest answered threads past the per-peer record cap, removing their files, and never a busy one", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-threads-"));
		tempDirs.push(dir);
		const host = new FakeHost();
		host.artifactsDir = dir;
		const store = new MeshThreadStore(host, { ttlMs: () => HOUR_MS });
		const records: MeshThreadRecord[] = [];
		for (let i = 0; i < MESH_MAX_THREADS_PER_PEER; i++) {
			const record = await store.create("status", alice, `m${i}`, `q${i}`);
			// The oldest stays in flight; the rest are answered.
			if (i > 0) store.updateTurn(record.threadId, 0, { status: "complete", answer: "a" });
			records.push(record);
		}
		await store.create("status", bob, "mb", "qb");
		await store.flush();
		expect(await files(dir)).toHaveLength(MESH_MAX_THREADS_PER_PEER + 1);

		const extra = await store.create("status", alice, "mx", "qx");
		await store.flush();
		const alive = (await store.list(alice.instanceId)).map(record => record.threadId);
		expect(alive).toHaveLength(MESH_MAX_THREADS_PER_PEER);
		expect(alive).toContain(records[0]!.threadId); // busy: kept although oldest
		expect(alive).toContain(extra.threadId);
		expect(alive).not.toContain(records[1]!.threadId); // oldest answered: evicted
		expect(alive).toContain(records[2]!.threadId);
		expect(await store.lookup(records[1]!.threadId, alice.instanceId)).toMatchObject({ code: "thread_expired" });
		expect(await files(dir)).not.toContain(`entry-${records[1]!.threadId}.json`);
		expect(await files(dir)).toHaveLength(MESH_MAX_THREADS_PER_PEER + 1);
		// Another peer's record is not touched by alice's eviction.
		expect(await store.list(bob.instanceId)).toHaveLength(1);
	});

	it("evicts the oldest answered threads past the total record cap, removing their files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-threads-"));
		tempDirs.push(dir);
		const host = new FakeHost();
		host.artifactsDir = dir;
		const store = new MeshThreadStore(host, { ttlMs: () => HOUR_MS });
		const records: MeshThreadRecord[] = [];
		for (let i = 0; i < MESH_MAX_THREADS_TOTAL; i++) {
			const record = await store.create("status", peerN(i), `m${i}`, `q${i}`);
			store.updateTurn(record.threadId, 0, { status: "complete", answer: "a" });
			records.push(record);
		}
		await store.flush();
		expect(await files(dir)).toHaveLength(MESH_MAX_THREADS_TOTAL);

		const extra = await store.create("status", peerN(100000), "mx", "qx");
		await store.flush();
		expect(await store.lookup(records[0]!.threadId, peerN(0).instanceId)).toMatchObject({ code: "thread_expired" });
		expect((await store.lookup(records[1]!.threadId, peerN(1).instanceId)).ok).toBe(true);
		expect((await store.lookup(extra.threadId, peerN(100000).instanceId)).ok).toBe(true);
		const names = await files(dir);
		expect(names).toHaveLength(MESH_MAX_THREADS_TOTAL);
		expect(names).not.toContain(`entry-${records[0]!.threadId}.json`);
	});

	it("refuses a follow-up past the turn cap and leaves the record unchanged", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-threads-"));
		tempDirs.push(dir);
		const host = new FakeHost();
		host.artifactsDir = dir;
		const store = new MeshThreadStore(host, { ttlMs: () => HOUR_MS });
		const record = await store.create("status", alice, "m0", "q0");
		store.updateTurn(record.threadId, 0, { status: "complete", answer: "a" });
		for (let i = 1; i < MESH_MAX_TURNS_PER_THREAD; i++) {
			expect(store.appendTurn(record.threadId, `m${i}`, `q${i}`)).toBe(i);
			store.updateTurn(record.threadId, i, { status: "complete", answer: "a" });
		}
		await store.flush();
		const onDisk = await fs.readFile(path.join(dir, "mesh-threads", `entry-${record.threadId}.json`), "utf8");

		const refused = await refusal(() => store.appendTurn(record.threadId, "mx", "qx"));
		expect(refused.code).toBe("bad_request");
		expect(refused.message).toContain("full");
		expect(record.turns).toHaveLength(MESH_MAX_TURNS_PER_THREAD);
		await store.flush();
		expect(await fs.readFile(path.join(dir, "mesh-threads", `entry-${record.threadId}.json`), "utf8")).toBe(onDisk);
	});
});

describe("meshConversationKey", () => {
	it("shares a provider lineage across successful turns and starts a new one after a failure", () => {
		const turn = (status: MeshThreadRecord["turns"][number]["status"]) => ({
			msgId: "m",
			question: "q",
			status,
			createdAt: 0,
			updatedAt: 0,
		});
		const record: MeshThreadRecord = {
			threadId: "t1",
			kind: "status",
			peer: alice,
			mainSessionId: "s",
			turns: [turn("complete"), turn("complete"), turn("error"), turn("complete"), turn("queued")],
			createdAt: 0,
			updatedAt: 0,
		};
		expect([0, 1, 2, 3, 4].map(index => meshConversationKey(record, index))).toEqual([
			"mesh:t1:0",
			"mesh:t1:0",
			"mesh:t1:0",
			"mesh:t1:3",
			"mesh:t1:3",
		]);
	});
});

describe("isMeshThreadResponder", () => {
	it("accepts only a transcript directly in the thread's own responder folder", () => {
		const artifacts = path.join(os.tmpdir(), "session");
		const own = path.join(meshResponderArtifactsDir(artifacts, "T1"), "MeshAsk.jsonl");
		// After a restart, the reused id `MeshAsk` may name another thread's responder.
		const other = path.join(meshResponderArtifactsDir(artifacts, "T2"), "MeshAsk.jsonl");
		const nested = path.join(meshResponderArtifactsDir(artifacts, "T1"), "MeshAsk", "MeshAsk.Child.jsonl");
		expect(isMeshThreadResponder(own, artifacts, "T1")).toBe(true);
		expect(isMeshThreadResponder(other, artifacts, "T1")).toBe(false);
		expect(isMeshThreadResponder(nested, artifacts, "T1")).toBe(false);
		expect(isMeshThreadResponder(path.join(artifacts, "MeshAsk.jsonl"), artifacts, "T1")).toBe(false);
		expect(isMeshThreadResponder(null, artifacts, "T1")).toBe(false);
	});
});
