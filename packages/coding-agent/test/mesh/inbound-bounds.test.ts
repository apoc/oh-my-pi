import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { MeshUiHooks } from "../../src/mesh/bridge";
import type { MeshInboundRequest } from "../../src/mesh/engine";
import {
	type MeshAnswerer,
	MeshFrontend,
	type MeshFrontendSession,
	type MeshResponderResult,
} from "../../src/mesh/inbound";
import { MeshOutbound } from "../../src/mesh/outbound";
import type { MeshInboundPolicy } from "../../src/mesh/settings";
import {
	MESH_MAX_THREADS_PER_PEER,
	MESH_MAX_TURNS_PER_THREAD,
	MESH_MAX_UNANSWERED_PER_PEER,
	MESH_MAX_UNANSWERED_TOTAL,
	type MeshThreadRecord,
} from "../../src/mesh/threads";
import type { MeshMessageKind, MeshRequest, MeshResponse, MeshSender } from "../../src/mesh/wire";
import type { AgentSessionEventListener } from "../../src/session/agent-session-events";
import type { CustomMessagePayload } from "../../src/session/messages";
import { ScriptedMeshEngine } from "./scripted-engine";

const sender = (n: number): MeshSender => ({
	instanceId: `inst-${n}`,
	agentId: "Main",
	displayName: `Peer ${n}`,
	host: "box",
});
const alice = sender(1);

class FakeSession implements MeshFrontendSession {
	isDisposed = false;
	isStreaming = false;
	readonly conversationId = "session-1";
	constructor(readonly artifactsDir: string) {}
	readonly sessionManager = {
		getSessionId: () => "session-1",
		getArtifactsDir: () => this.artifactsDir,
	};
	async sendCustomMessage(_message: CustomMessagePayload): Promise<boolean> {
		return false;
	}
	subscribeRunState(_listener: (state: "running" | "idle") => void): () => void {
		return () => {};
	}
	subscribe(_listener: AgentSessionEventListener): () => void {
		return () => {};
	}
	registerSessionChangeCallback(_callback: () => void): () => void {
		return () => {};
	}
}

/** Answers on demand; every question text is unique per test. */
class FakeAnswerer implements MeshAnswerer {
	readonly #pending = new Map<string, PromiseWithResolvers<MeshResponderResult>>();
	answer(record: MeshThreadRecord, turnIndex: number): Promise<MeshResponderResult> {
		const deferred = Promise.withResolvers<MeshResponderResult>();
		this.#pending.set(record.turns[turnIndex]!.question, deferred);
		return deferred.promise;
	}
	finish(question: string): void {
		this.#pending.get(question)?.resolve({ text: `answer to ${question}` });
	}
	fail(question: string): void {
		this.#pending.get(question)?.reject(new Error("responder blew up"));
	}
}

function inbound(from: MeshSender, body: MeshRequest): MeshInboundRequest {
	return {
		requestId: crypto.randomUUID(),
		envelope: { v: 1, msgId: crypto.randomUUID(), sentAt: Date.now(), hop: 0, from, to: "inst-self", body },
		origin: { kind: "local" },
	};
}

function message(kind: MeshMessageKind, text: string, thread?: string): MeshRequest {
	return { op: "message", kind, text, ...(thread ? { thread } : {}) };
}

async function settle(): Promise<void> {
	for (let tick = 0; tick < 1000; tick++) await Promise.resolve();
}

function thread(response: MeshResponse): string {
	if (!response.ok) throw new Error(response.message);
	const value = isRecord(response.data) ? response.data.thread : undefined;
	if (typeof value !== "string") throw new Error("response lacks thread");
	return value;
}

const frontends: MeshFrontend[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
	for (const frontend of frontends.splice(0)) {
		frontend.detach();
		frontend.outbound.dispose();
	}
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(options: { policy?: MeshInboundPolicy; hasUI?: boolean } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-inbound-bounds-"));
	tempDirs.push(dir);
	const engine = new ScriptedMeshEngine();
	const session = new FakeSession(dir);
	const answerer = new FakeAnswerer();
	const hooks = { incoming: 0, approvals: 0 };
	const ui: MeshUiHooks | undefined =
		options.hasUI === undefined
			? undefined
			: {
					hasUI: options.hasUI,
					showIncoming: () => {
						hooks.incoming++;
					},
					showOutgoing: () => {},
					notifyApproval: () => {
						hooks.approvals++;
					},
				};
	const frontend = new MeshFrontend({
		engine,
		session,
		answerer,
		ui,
		settings: {
			policy: () => options.policy ?? "allow",
			maxConcurrentAsks: () => 1,
			threadTtlMs: () => 60 * 60 * 1000,
		},
		outbound: new MeshOutbound({ engine, main: session, ui }),
	});
	frontends.push(frontend);
	const threadFiles = async () => {
		await frontend.threads.flush();
		return (await fs.readdir(path.join(dir, "mesh-threads")).catch(() => [])).sort();
	};
	return { answerer, frontend, hooks, threadFiles };
}

describe("MeshFrontend inbound bounds", () => {
	it("refuses a peer's unanswered ask past the per-peer cap with busy, creating no thread or file, until one completes", async () => {
		const { answerer, frontend, threadFiles } = await setup();
		for (let i = 0; i < MESH_MAX_UNANSWERED_PER_PEER; i++) {
			expect(await frontend.handle(inbound(alice, message("ask", `q${i}`)))).toMatchObject({ ok: true });
		}
		await settle();
		const files = await threadFiles();
		expect(files).toHaveLength(MESH_MAX_UNANSWERED_PER_PEER);

		expect(await frontend.handle(inbound(alice, message("ask", "over")))).toMatchObject({ ok: false, code: "busy" });
		expect(await frontend.handle(inbound(alice, message("task", "over-task")))).toMatchObject({
			ok: false,
			code: "busy",
		});
		expect(await frontend.threads.list(alice.instanceId)).toHaveLength(MESH_MAX_UNANSWERED_PER_PEER);
		expect(await threadFiles()).toEqual(files);

		answerer.finish("q0");
		await settle();
		expect(await frontend.handle(inbound(alice, message("ask", "after")))).toMatchObject({ ok: true });
	});

	it("refuses past the total cap across peers, for status threads too", async () => {
		const { frontend, threadFiles } = await setup();
		for (let i = 0; i < MESH_MAX_UNANSWERED_TOTAL; i++) {
			expect(await frontend.handle(inbound(sender(i), message("status", `q${i}`)))).toMatchObject({ ok: true });
		}
		await settle();
		const files = await threadFiles();

		const late = sender(1000);
		expect(await frontend.handle(inbound(late, message("status", "over")))).toMatchObject({
			ok: false,
			code: "busy",
		});
		expect(await frontend.threads.list(late.instanceId)).toEqual([]);
		expect(await threadFiles()).toEqual(files);
	});

	it("counts concurrent arrivals against the cap", async () => {
		const { frontend } = await setup();
		const responses = await Promise.all(
			Array.from({ length: MESH_MAX_UNANSWERED_PER_PEER + 4 }, (_, i) =>
				frontend.handle(inbound(alice, message("ask", `q${i}`))),
			),
		);
		expect(responses.filter(response => response.ok)).toHaveLength(MESH_MAX_UNANSWERED_PER_PEER);
		expect(responses.filter(response => !response.ok && response.code === "busy")).toHaveLength(4);
	});

	it("refuses a follow-up past the turn cap with bad_request and leaves the record unchanged", async () => {
		const { answerer, frontend, threadFiles } = await setup();
		const threadId = thread(await frontend.handle(inbound(alice, message("ask", "t0"))));
		await settle();
		answerer.finish("t0");
		await settle();
		for (let i = 1; i < MESH_MAX_TURNS_PER_THREAD; i++) {
			expect(await frontend.handle(inbound(alice, message("ask", `t${i}`, threadId)))).toMatchObject({ ok: true });
			await settle();
			answerer.finish(`t${i}`);
			await settle();
		}
		const files = await threadFiles();
		const lookup = await frontend.threads.lookup(threadId, alice.instanceId);
		if (!lookup.ok) throw new Error(lookup.message);
		const before = JSON.stringify(lookup.record);

		const refused = await frontend.handle(inbound(alice, message("ask", "overflow", threadId)));
		expect(refused).toMatchObject({ ok: false, code: "bad_request" });
		expect(!refused.ok && refused.message).toContain("full");
		expect(lookup.record.turns).toHaveLength(MESH_MAX_TURNS_PER_THREAD);
		expect(JSON.stringify(lookup.record)).toBe(before);
		expect(await threadFiles()).toEqual(files);
	});

	it("refuses before asking the human: a refused ask adds no approval and no UI call", async () => {
		const { frontend, hooks } = await setup({ policy: "ask", hasUI: true });
		for (let i = 0; i < MESH_MAX_UNANSWERED_PER_PEER; i++) {
			expect(await frontend.handle(inbound(alice, message("ask", `q${i}`)))).toMatchObject({
				ok: true,
				data: { pending: "approval" },
			});
		}
		expect(frontend.approvals.list()).toHaveLength(MESH_MAX_UNANSWERED_PER_PEER);
		expect(hooks).toEqual({ incoming: MESH_MAX_UNANSWERED_PER_PEER, approvals: MESH_MAX_UNANSWERED_PER_PEER });

		expect(await frontend.handle(inbound(alice, message("ask", "over")))).toMatchObject({ ok: false, code: "busy" });
		expect(frontend.approvals.list()).toHaveLength(MESH_MAX_UNANSWERED_PER_PEER);
		expect(hooks).toEqual({ incoming: MESH_MAX_UNANSWERED_PER_PEER, approvals: MESH_MAX_UNANSWERED_PER_PEER });
	});

	it("frees the slot when the user declines the approval", async () => {
		const { frontend } = await setup({ policy: "ask", hasUI: true });
		for (let i = 0; i < MESH_MAX_UNANSWERED_PER_PEER; i++)
			await frontend.handle(inbound(alice, message("ask", `q${i}`)));
		expect(await frontend.handle(inbound(alice, message("ask", "over")))).toMatchObject({ ok: false, code: "busy" });

		frontend.approvals.resolve(frontend.approvals.list()[0]!.id, false);
		await settle();
		expect(await frontend.handle(inbound(alice, message("ask", "after")))).toMatchObject({ ok: true });
	});

	it("frees the slot when the responder fails", async () => {
		const { answerer, frontend } = await setup();
		for (let i = 0; i < MESH_MAX_UNANSWERED_PER_PEER; i++)
			await frontend.handle(inbound(alice, message("ask", `q${i}`)));
		await settle();
		expect(await frontend.handle(inbound(alice, message("ask", "over")))).toMatchObject({ ok: false, code: "busy" });

		answerer.fail("q0");
		await settle();
		expect(await frontend.handle(inbound(alice, message("ask", "after")))).toMatchObject({ ok: true });
	});

	it("answers a follow-up racing the eviction of its thread with thread_expired", async () => {
		const { answerer, frontend } = await setup();
		const threadIds: string[] = [];
		for (let i = 0; i < MESH_MAX_THREADS_PER_PEER; i++) {
			threadIds.push(thread(await frontend.handle(inbound(alice, message("status", `s${i}`)))));
			await settle();
			answerer.finish(`s${i}`);
			await settle();
		}

		// The new thread evicts the oldest answered one while the follow-up is between its lookup and its append.
		const [followUp, created] = await Promise.all([
			frontend.handle(inbound(alice, message("status", "follow-up", threadIds[0]))),
			frontend.handle(inbound(alice, message("status", "fresh"))),
		]);
		expect(followUp).toMatchObject({ ok: false, code: "thread_expired" });
		expect(created).toMatchObject({ ok: true });
	});
});
