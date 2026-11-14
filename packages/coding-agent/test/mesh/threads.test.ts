import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type MeshThreadHost,
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
