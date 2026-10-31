/**
 * Inbound mesh frontend: routes the requests the engine could not answer itself. Policy per message
 * kind (`mesh.inbound.<kind>`): `allow`, `ask` (TUI approval; denied when headless) or `deny`.
 * Thread kinds (status/ask/task) are acknowledged at once with `{accepted, msgId, thread}` and
 * answered later by a `reply` request to the sender. Nothing here sends mesh requests other than
 * those replies and `watch_event`s.
 */
import { logger, Snowflake, toError } from "@oh-my-pi/pi-utils";
import type { Derived, ScopeLike } from "../config/registry";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEventListener } from "../session/agent-session-events";
import type { SessionManager } from "../session/session-manager";
import { MeshApprovals } from "./approvals";
import { buildMeshIncomingMessage, type MeshDeliveryTarget, type MeshUiHooks } from "./bridge";
import type { MeshEngine, MeshInboundRequest } from "./engine";
import { MeshOutbound } from "./outbound";
import {
	cfgMeshInboundAsk,
	cfgMeshInboundNote,
	cfgMeshInboundStatus,
	cfgMeshInboundSteer,
	cfgMeshInboundTask,
	cfgMeshMaxConcurrentAsks,
	cfgMeshThreadTtlHours,
} from "./settings";
import { isValidMeshThreadId, type MeshThreadRecord, MeshThreadStore } from "./threads";
import { meshToolRefs } from "./tool-refs";
import {
	MAX_TEXT_CHARS,
	MAX_WATCH_TTL_SEC,
	type MeshEnvelope,
	type MeshMessageKind,
	type MeshRequest,
	type MeshResponse,
	type MeshSender,
	type MeshWatchEvent,
	meshError,
	meshOk,
} from "./wire";

export type MeshInboundPolicy = "allow" | "ask" | "deny";

/** Active watches one peer instance may hold. */
const MAX_WATCHES_PER_PEER = 16;

const INBOUND_POLICY: Record<MeshMessageKind, Derived<MeshInboundPolicy>> = {
	status: cfgMeshInboundStatus,
	ask: cfgMeshInboundAsk,
	steer: cfgMeshInboundSteer,
	task: cfgMeshInboundTask,
	note: cfgMeshInboundNote,
};

/** The parts of the main session the frontend drives; `AgentSession` satisfies it. */
export interface MeshFrontendSession extends MeshDeliveryTarget {
	readonly isStreaming: boolean;
	readonly sessionManager: Pick<SessionManager, "getSessionId" | "getArtifactsDir">;
	subscribeRunState(listener: (state: "running" | "idle") => void): () => void;
	subscribe(listener: AgentSessionEventListener): () => void;
	registerSessionChangeCallback(callback: () => void): () => void;
}

/** A responder failure whose message is safe to show the asking peer; anything else stays local. */
export class MeshPeerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MeshPeerError";
	}
}

export interface MeshResponderResult {
	text: string;
	/** Responder to continue on the next follow-up; omitted fields clear the thread's previous one. */
	responder?: { forkAgentId: string; forkLeafId?: string | null };
}

/** Answers one thread turn (`MeshResponder` in production). */
export interface MeshAnswerer {
	answer(record: MeshThreadRecord, turnIndex: number, signal: AbortSignal): Promise<MeshResponderResult>;
}

/** Live settings the frontend reads per request. */
export interface MeshInboundSettings {
	policy(kind: MeshMessageKind): MeshInboundPolicy;
	maxConcurrentAsks(): number;
	threadTtlMs(): number;
}

export interface MeshFrontendDeps {
	engine: MeshEngine;
	session: MeshFrontendSession;
	settings: MeshInboundSettings;
	answerer: MeshAnswerer;
	ui?: MeshUiHooks;
	/** Sender side shared across frontend rebinds (host-owned); the frontend creates and owns one when absent. */
	outbound?: MeshOutbound;
	/** Approval TTL override (tests). */
	approvalTtlMs?: number;
}

/** FIFO concurrency gate whose limit follows a live setting. */
class ConcurrencyGate {
	readonly #limit: () => number;
	readonly #waiters: (() => void)[] = [];
	#running = 0;

	constructor(limit: () => number) {
		this.#limit = limit;
	}

	async run<T>(work: () => Promise<T>): Promise<T> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push(resolve);
		// Arrivals and releases both re-read the live limit; admission stays FIFO, so a newcomer never
		// overtakes queued work, and a raised limit admits the queue before it.
		this.#admit();
		await promise;
		try {
			return await work();
		} finally {
			this.#running--;
			this.#admit();
		}
	}

	#admit(): void {
		while (this.#waiters.length > 0 && this.#running < this.#capacity()) {
			this.#running++;
			this.#waiters.shift()!();
		}
	}

	#capacity(): number {
		return Math.max(1, this.#limit());
	}
}

interface ActiveWatch {
	peerInstanceId: string;
	dispose: () => void;
}

export class MeshFrontend {
	readonly approvals: MeshApprovals;
	readonly outbound: MeshOutbound;
	readonly #ownsOutbound: boolean;
	readonly threads: MeshThreadStore;
	readonly #engine: MeshEngine;
	readonly #session: MeshFrontendSession;
	readonly #settings: MeshInboundSettings;
	readonly #answerer: MeshAnswerer;
	readonly #ui: MeshUiHooks | undefined;
	readonly #gate: ConcurrencyGate;
	readonly #watches = new Map<string, ActiveWatch>();
	readonly #abort = new AbortController();
	#detachHandler: (() => void) | undefined;

	constructor(deps: MeshFrontendDeps) {
		this.#engine = deps.engine;
		this.#session = deps.session;
		this.#settings = deps.settings;
		this.#answerer = deps.answerer;
		this.#ui = deps.ui;
		this.#gate = new ConcurrencyGate(() => deps.settings.maxConcurrentAsks());
		this.approvals = new MeshApprovals({ ttlMs: deps.approvalTtlMs });
		this.#ownsOutbound = deps.outbound === undefined;
		this.outbound = deps.outbound ?? new MeshOutbound({ engine: deps.engine, main: deps.session, ui: deps.ui });
		this.outbound.setMain(deps.session);
		const sessionManager = deps.session.sessionManager;
		this.threads = new MeshThreadStore(
			{
				getSessionId: () => sessionManager.getSessionId(),
				getArtifactsDir: () => sessionManager.getArtifactsDir(),
				registerSessionChangeCallback: callback => deps.session.registerSessionChangeCallback(callback),
			},
			{ ttlMs: () => deps.settings.threadTtlMs() },
		);
	}

	/**
	 * Serve inbound mesh requests for `session` until {@link detach}. Host wiring passes
	 * `new MeshResponder(session)` as `answerer` (this module stays free of the subagent stack) and
	 * its long-lived `outbound`, so in-flight sends survive rebinding to another session.
	 */
	static attach(options: {
		engine: MeshEngine;
		session: AgentSession;
		settings: ScopeLike;
		answerer: MeshAnswerer;
		outbound?: MeshOutbound;
		ui?: MeshUiHooks;
	}): MeshFrontend {
		const { settings } = options;
		const frontend = new MeshFrontend({
			engine: options.engine,
			session: options.session,
			settings: {
				policy: kind => INBOUND_POLICY[kind].get(settings),
				maxConcurrentAsks: () => cfgMeshMaxConcurrentAsks.get(settings),
				threadTtlMs: () => cfgMeshThreadTtlHours.get(settings) * 60 * 60 * 1000,
			},
			answerer: options.answerer,
			outbound: options.outbound,
			ui: options.ui,
		});
		frontend.#detachHandler = options.engine.setInboundHandler(request => frontend.handle(request));
		return frontend;
	}

	detach(): void {
		this.#detachHandler?.();
		this.#detachHandler = undefined;
		this.#abort.abort(new Error("Mesh frontend detached."));
		this.approvals.denyAll();
		for (const watch of this.#watches.values()) watch.dispose();
		this.threads.dispose();
		if (this.#ownsOutbound) this.outbound.dispose();
	}

	/** Answer one inbound request (the engine's inbound handler). */
	async handle(request: MeshInboundRequest): Promise<MeshResponse> {
		const { envelope } = request;
		const body = envelope.body;
		try {
			switch (body.op) {
				case "message":
					return await this.#onMessage(envelope, body);
				case "reply":
				case "watch_event":
					return this.outbound.deliverIncomingReply(body, envelope.from);
				case "watch":
					return this.#onWatch(envelope.from, body.event, body.ttlSec);
				case "threads":
					return await this.#onThreads(envelope.from);
				case "thread":
					return await this.#onThread(envelope.from, body.thread);
				case "snapshot":
					return meshError("unsupported", "Snapshots are served by the engine.");
			}
		} catch (error) {
			logger.warn("mesh: inbound request failed", { op: body.op, error: toError(error).message });
			return meshError("internal", "The request failed on this instance.");
		}
	}

	async #onMessage(envelope: MeshEnvelope, body: Extract<MeshRequest, { op: "message" }>): Promise<MeshResponse> {
		const { from, msgId } = envelope;
		const { kind, text } = body;
		const policy = this.#settings.policy(kind);
		const hasUI = this.#ui?.hasUI === true;
		if (policy === "deny") return meshError("denied", `This instance does not accept ${kind} messages.`);
		if (policy === "ask" && !hasUI) {
			return meshError("denied", `This instance asks before accepting ${kind} messages and has no UI to ask.`);
		}
		if (kind === "note" && !hasUI) return meshError("denied", "This instance has no UI to show notes.");
		// Approval outlives the inbound request, so it runs after the acknowledgement; a denial
		// becomes the error of the reply.
		const approve = () => (policy === "ask" ? this.#requestApproval(from, kind, text) : undefined);

		if (kind === "steer" || kind === "note") {
			this.#deliverDirect(kind, from, msgId, text, approve()).catch(error =>
				logger.warn("mesh: inbound delivery failed", { kind, error: toError(error).message }),
			);
			return meshOk({ accepted: true, msgId });
		}

		let record: MeshThreadRecord;
		let turnIndex: number;
		if (body.thread !== undefined) {
			if (!isValidMeshThreadId(body.thread)) return meshError("unknown_thread", `Unknown thread ${body.thread}.`);
			const lookup = await this.threads.lookup(body.thread, from.instanceId);
			if (!lookup.ok) return meshError(lookup.code, lookup.message);
			if (lookup.record.kind !== kind) {
				return meshError("bad_request", `Thread ${body.thread} is a ${lookup.record.kind} thread.`);
			}
			record = lookup.record;
			turnIndex = this.threads.appendTurn(record.threadId, msgId, text);
		} else {
			record = await this.threads.create(kind, from, msgId, text);
			turnIndex = 0;
		}
		this.#runTurn(record, turnIndex, approve()).catch(error =>
			logger.warn("mesh: thread turn failed", { thread: record.threadId, error: toError(error).message }),
		);
		return meshOk({ accepted: true, msgId, thread: record.threadId });
	}

	#requestApproval(from: MeshSender, kind: MeshMessageKind, text: string): Promise<boolean> {
		const decision = this.approvals.request(from, kind, text);
		this.#ui?.notifyApproval();
		return decision;
	}

	async #deliverDirect(
		kind: "steer" | "note",
		from: MeshSender,
		msgId: string,
		text: string,
		approval: Promise<boolean> | undefined,
	): Promise<void> {
		if (approval && !(await approval)) {
			// Nothing tracks a note's answer on the sending side, so only a steer hears of its denial.
			if (kind === "steer") {
				await this.#sendReply(from, msgId, undefined, { error: "denied: the user declined this steer." });
			}
			return;
		}
		if (kind === "note") {
			this.#ui?.showNote(from, text);
			return;
		}
		if (this.#session.isDisposed) {
			await this.#sendReply(from, msgId, undefined, { error: "internal: the recipient session is closed." });
			return;
		}
		try {
			await this.#session.deliverMeshMessage(
				buildMeshIncomingMessage({ from, msgId, text, toolRefs: meshToolRefs(this.#session.toolSession ?? {}) }),
			);
		} catch (error) {
			// Delivery also awaits the turn it woke, so this may be that turn's failure, not a lost steer.
			logger.warn("mesh: steer turn failed", { from: from.instanceId, error: toError(error).message });
		}
	}

	/**
	 * Thread order covers approvals too: a follow-up approved first still waits for the turn before
	 * it. A thread that expired meanwhile (session switch, TTL) is answered `thread_expired` instead
	 * of being answered from another conversation.
	 */
	async #runTurn(record: MeshThreadRecord, turnIndex: number, approval: Promise<boolean> | undefined): Promise<void> {
		const { threadId } = record;
		const msgId = record.turns[turnIndex]!.msgId;
		await this.threads.runSerialized(threadId, async () => {
			if (approval && !(await approval)) {
				this.threads.updateTurn(threadId, turnIndex, { status: "error", error: "denied" });
				await this.#sendReply(record.peer, msgId, threadId, {
					error: `denied: the user declined this ${record.kind}.`,
				});
				return;
			}
			const answer = () =>
				this.threads.isLive(record) ? this.#answer(record, turnIndex) : this.#replyExpired(record, msgId);
			await (record.kind === "status" ? answer() : this.#gate.run(answer));
		});
	}

	#replyExpired(record: MeshThreadRecord, msgId: string): Promise<void> {
		return this.#sendReply(record.peer, msgId, record.threadId, {
			error: `thread_expired: thread ${record.threadId} expired before it could be answered.`,
		});
	}

	async #answer(record: MeshThreadRecord, turnIndex: number): Promise<void> {
		const { threadId } = record;
		const msgId = record.turns[turnIndex]!.msgId;
		this.threads.updateTurn(threadId, turnIndex, { status: "running" });
		let result: MeshResponderResult;
		try {
			result = await this.#answerer.answer(record, turnIndex, this.#abort.signal);
		} catch (error) {
			// Peers see only messages meant for them; local detail (paths, stack hints) stays in the log.
			const message = error instanceof MeshPeerError ? error.message : "internal: the answer could not be produced.";
			if (!(error instanceof MeshPeerError)) {
				logger.warn("mesh: responder failed", { thread: threadId, error: toError(error).message });
			}
			this.threads.updateTurn(threadId, turnIndex, { status: "error", error: message });
			await this.#sendReply(record.peer, msgId, threadId, { error: message });
			return;
		}
		if (result.responder) this.outbound.blockSender(result.responder.forkAgentId);
		this.threads.setResponder(threadId, result.responder ?? {});
		this.threads.updateTurn(threadId, turnIndex, { status: "complete", answer: result.text });
		await this.#sendReply(record.peer, msgId, threadId, { text: result.text });
	}

	/** Send the answer to `replyTo`; failures are logged, the thread keeps the answer for `thread`. */
	async #sendReply(
		to: Pick<MeshSender, "instanceId">,
		replyTo: string,
		thread: string | undefined,
		answer: { text: string } | { error: string },
	): Promise<void> {
		// The engine rejects oversized text; a cut answer beats none.
		const error = "error" in answer ? answer.error.slice(0, MAX_TEXT_CHARS) : undefined;
		const text = "text" in answer ? answer.text.slice(0, MAX_TEXT_CHARS) : "";
		try {
			const response = await this.#engine.request(to.instanceId, MAIN_AGENT_ID, {
				op: "reply",
				replyTo,
				...(thread ? { thread } : {}),
				text,
				...(error !== undefined ? { error } : {}),
			});
			if (!response.ok) {
				logger.warn("mesh: peer rejected a reply", {
					to: to.instanceId,
					code: response.code,
					message: response.message,
				});
			}
		} catch (error) {
			logger.warn("mesh: reply send failed", { to: to.instanceId, error: toError(error).message });
		}
	}

	#onWatch(from: MeshSender, event: MeshWatchEvent, ttlSec: number): MeshResponse {
		if (!Number.isFinite(ttlSec) || ttlSec <= 0) return meshError("bad_request", "Watch TTL must be positive.");
		let held = 0;
		for (const watch of this.#watches.values()) if (watch.peerInstanceId === from.instanceId) held++;
		if (held >= MAX_WATCHES_PER_PEER) return meshError("busy", "Too many active watches from this instance.");

		const watchId = Snowflake.next();
		let unsubscribe: () => void = () => {};
		const dispose = () => {
			clearTimeout(timer);
			unsubscribe();
			this.#watches.delete(watchId);
		};
		const fire = () => {
			if (!this.#watches.has(watchId)) return;
			dispose();
			void this.#engine
				.request(from.instanceId, MAIN_AGENT_ID, { op: "watch_event", watchId, event })
				.then(response => {
					if (!response.ok) logger.warn("mesh: peer rejected a watch event", { code: response.code });
				})
				.catch(error => logger.warn("mesh: watch event send failed", { error: toError(error).message }));
		};
		const timer = setTimeout(dispose, Math.min(ttlSec, MAX_WATCH_TTL_SEC) * 1000);
		timer.unref();
		this.#watches.set(watchId, { peerInstanceId: from.instanceId, dispose });
		if (event === "idle") {
			unsubscribe = this.#session.subscribeRunState(state => {
				if (state === "idle") fire();
			});
			// Already idle: the event the peer waits for has happened. Fire after the acknowledgement.
			if (!this.#session.isStreaming) setImmediate(fire);
		} else {
			unsubscribe = this.#session.subscribe(sessionEvent => {
				if (sessionEvent.type === "turn_end") fire();
			});
		}
		return meshOk({ watchId });
	}

	async #onThreads(from: MeshSender): Promise<MeshResponse> {
		const records = await this.threads.list(from.instanceId);
		return meshOk({
			threads: records.map(record => ({
				thread: record.threadId,
				kind: record.kind,
				turns: record.turns.length,
				status: record.turns.at(-1)?.status,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			})),
		});
	}

	async #onThread(from: MeshSender, thread: string): Promise<MeshResponse> {
		if (!isValidMeshThreadId(thread)) return meshError("unknown_thread", `Unknown thread ${thread}.`);
		const lookup = await this.threads.lookup(thread, from.instanceId);
		if (!lookup.ok) return meshError(lookup.code, lookup.message);
		const { record } = lookup;
		return meshOk({
			thread: record.threadId,
			kind: record.kind,
			turns: record.turns.map(turn => ({
				question: turn.question,
				...(turn.answer !== undefined ? { answer: turn.answer } : {}),
				...(turn.error !== undefined ? { error: turn.error } : {}),
				status: turn.status,
				createdAt: turn.createdAt,
				updatedAt: turn.updatedAt,
			})),
		});
	}
}
