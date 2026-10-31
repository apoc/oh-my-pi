/**
 * Sender side of mesh messaging. Thread kinds and steers are acknowledged immediately and answered
 * later by a separate `reply` request; watches fire one `watch_event`. This class remembers which
 * local agent sent each message, hands an answer to a caller waiting on it, and otherwise delivers
 * it late to the asking agent: Main and live subagents get a hidden `mesh:reply` (or `mesh:watch`) message, a
 * finished subagent's answer goes to Main naming the agent, the TUI user's answer to the UI.
 */
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { isLocalAgentSession } from "../session/agent-session-handle";
import type { CustomMessagePayload } from "../session/messages";
import { buildMeshReplyMessage, buildMeshWatchEventMessage, type MeshDeliveryTarget, type MeshUiHooks } from "./bridge";
import type { MeshEngine } from "./engine";
import { isValidMeshThreadId } from "./threads";
import { meshToolRefs } from "./tool-refs";
import {
	MESH_ANY_INSTANCE,
	type MeshErrorCode,
	type MeshMessageKind,
	type MeshRequest,
	type MeshResponse,
	type MeshSender,
	type MeshWatchEvent,
	meshError,
	meshOk,
} from "./wire";

/** `agentId` of messages the human sends from the TUI. */
export const MESH_USER_AGENT_ID = "user";
/** How long a sent message keeps routing its replies to the asking agent. */
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PENDING = 1024;
/** Answers that overtook their own acknowledgement wait this long to be claimed. */
const EARLY_TTL_MS = 60 * 1000;
const MAX_EARLY = 64;
/** Wire-level id shape (Rust `is_msg_id`); acks carrying anything else are refused. */
const MESH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type MeshIncomingReply =
	| { op: "reply"; from: MeshSender; replyTo: string; thread?: string; text: string; error?: string }
	| { op: "watch_event"; from: MeshSender; watchId: string; event: MeshWatchEvent; detail?: string };

export type MeshSendResult =
	| { ok: true; msgId: string; thread?: string }
	| { ok: false; code: MeshErrorCode; message: string };

export type MeshWatchSendResult = { ok: true; watchId: string } | { ok: false; code: MeshErrorCode; message: string };

interface PendingEntry {
	op: MeshIncomingReply["op"];
	peerInstanceId: string;
	agentId: string;
	/** Main session bound when the message was sent: late answers go there, never to a later rebind. */
	main: MeshDeliveryTarget;
	/** `main.conversationId` at send time; a later `/new`, context reset, resume or fork there makes the answer stale. */
	conversationId: string;
	expiresAt: number;
	/** Keep answers for an `awaitReply` the caller is about to start instead of delivering them late. */
	held: boolean;
	stored?: MeshIncomingReply;
	waiter?: (reply: MeshIncomingReply | undefined) => void;
}

export interface MeshOutboundOptions {
	engine: MeshEngine;
	/** The main session: receives Main's late replies and those of agents that stopped. Rebindable via {@link MeshOutbound.setMain}. */
	main: MeshDeliveryTarget;
	ui?: MeshUiHooks;
	/** Live session of a local subagent; defaults to the agent registry. */
	resolveAgent?: (agentId: string) => MeshDeliveryTarget | undefined;
}

/** A worker-homed subagent's handle has no `sendCustomMessage`; its answers fall back to Main like a stopped agent's. */
function liveRegistrySession(agentId: string): MeshDeliveryTarget | undefined {
	const ref = AgentRegistry.global().get(agentId);
	if (!ref?.session || (ref.status !== "running" && ref.status !== "idle")) return undefined;
	return isLocalAgentSession(ref.session) ? ref.session : undefined;
}

export class MeshOutbound {
	readonly #engine: MeshEngine;
	#main: MeshDeliveryTarget;
	readonly #ui: MeshUiHooks | undefined;
	readonly #resolveAgent: (agentId: string) => MeshDeliveryTarget | undefined;
	readonly #pending = new Map<string, PendingEntry>();
	readonly #early = new Map<string, { reply: MeshIncomingReply; expiresAt: number }>();
	readonly #blockedSenders = new Set<string>();

	constructor(options: MeshOutboundOptions) {
		this.#engine = options.engine;
		this.#main = options.main;
		this.#ui = options.ui;
		this.#resolveAgent = options.resolveAgent ?? liveRegistrySession;
	}

	/** Refuse sends from `agentId` and its descendants (mesh responders: hop limit). */
	blockSender(agentId: string): void {
		this.#blockedSenders.add(agentId);
	}

	/** Main session for messages sent from now on (host rebinding the mesh); earlier sends keep their own. */
	setMain(main: MeshDeliveryTarget): void {
		this.#main = main;
	}

	/** Engine stop: release every waiter and forget all pending messages. */
	dispose(): void {
		for (const entry of this.#pending.values()) entry.waiter?.(undefined);
		this.#pending.clear();
		this.#early.clear();
	}

	/**
	 * Send a `message`. Replies to it (thread kinds and steers) route back to `fromAgentId`; pass
	 * `awaitReply: true` when an {@link awaitReply} call follows, so an early answer is kept for it.
	 * Transport failures reject with `MeshEngineError`.
	 */
	async send(args: {
		to: string;
		fromAgentId: string;
		kind: MeshMessageKind;
		text: string;
		thread?: string;
		awaitReply?: boolean;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<MeshSendResult> {
		const body: MeshRequest = {
			op: "message",
			kind: args.kind,
			text: args.text,
			...(args.thread ? { thread: args.thread } : {}),
		};
		const sent = { main: this.#main, conversationId: this.#main.conversationId };
		const response = await this.#request(args.to, args.fromAgentId, body, args);
		if (!response.ok) return response;
		const data = response.data;
		if (
			!isRecord(data) ||
			typeof data.msgId !== "string" ||
			!MESH_ID_RE.test(data.msgId) ||
			(data.thread !== undefined && (typeof data.thread !== "string" || !isValidMeshThreadId(data.thread)))
		) {
			return { ok: false, code: "internal", message: "Peer acknowledged with a missing or malformed message id." };
		}
		// Notes are for the peer's human: nothing answers them, not even a declined approval.
		if (args.kind !== "note") {
			this.#track("reply", data.msgId, args.to, args.fromAgentId, args.awaitReply === true, sent);
		}
		return { ok: true, msgId: data.msgId, ...(typeof data.thread === "string" ? { thread: data.thread } : {}) };
	}

	/** Register a one-shot watch on the peer; its event routes like a reply, keyed by `watchId`. */
	async watch(args: {
		to: string;
		fromAgentId: string;
		event: MeshWatchEvent;
		ttlSec: number;
		awaitReply?: boolean;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<MeshWatchSendResult> {
		const sent = { main: this.#main, conversationId: this.#main.conversationId };
		const response = await this.#request(
			args.to,
			args.fromAgentId,
			{ op: "watch", event: args.event, ttlSec: args.ttlSec },
			args,
		);
		if (!response.ok) return response;
		const data = response.data;
		if (!isRecord(data) || typeof data.watchId !== "string" || !MESH_ID_RE.test(data.watchId)) {
			return {
				ok: false,
				code: "internal",
				message: "Peer accepted the watch with a missing or malformed watch id.",
			};
		}
		this.#track(
			"watch_event",
			data.watchId,
			args.to,
			args.fromAgentId,
			args.awaitReply === true,
			sent,
			args.ttlSec * 1000,
		);
		return { ok: true, watchId: data.watchId };
	}

	/** Answer a peer's message (`replyTo` = its msgId), e.g. Main replying to a steer. */
	reply(args: {
		to: string;
		fromAgentId: string;
		replyTo: string;
		thread?: string;
		text: string;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<MeshResponse> {
		return this.#request(
			args.to,
			args.fromAgentId,
			{ op: "reply", replyTo: args.replyTo, ...(args.thread ? { thread: args.thread } : {}), text: args.text },
			args,
		);
	}

	/**
	 * Wait for the answer to `key` (a msgId, or a watchId). Resolves `undefined` on timeout or abort;
	 * answers arriving after that are delivered late to the asking agent.
	 */
	awaitReply(key: string, timeoutMs: number, signal?: AbortSignal): Promise<MeshIncomingReply | undefined> {
		const entry = this.#pending.get(key);
		if (!entry) return Promise.resolve(undefined);
		if (entry.stored) {
			const stored = entry.stored;
			entry.stored = undefined;
			entry.held = false;
			return Promise.resolve(stored);
		}
		entry.waiter?.(undefined);
		const { promise, resolve } = Promise.withResolvers<MeshIncomingReply | undefined>();
		const finish = (reply: MeshIncomingReply | undefined) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (entry.waiter === finish) entry.waiter = undefined;
			entry.held = false;
			resolve(reply);
		};
		const onAbort = () => finish(undefined);
		const timer = setTimeout(onAbort, timeoutMs);
		entry.waiter = finish;
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		return promise;
	}

	/** Inbound `reply` / `watch_event` from `from`. */
	deliverIncomingReply(body: Extract<MeshRequest, { op: "reply" | "watch_event" }>, from: MeshSender): MeshResponse {
		const reply: MeshIncomingReply = { ...body, from };
		const key = reply.op === "reply" ? reply.replyTo : reply.watchId;
		const entry = this.#pending.get(key);
		if (!entry) {
			// The answer can overtake the acknowledgement of its own request.
			this.#pruneEarly();
			if (this.#early.size >= MAX_EARLY) return meshError("busy", "Too many unclaimed replies.");
			this.#early.set(key, { reply, expiresAt: Date.now() + EARLY_TTL_MS });
			return meshOk({ accepted: true });
		}
		if (!this.#accepts(entry, reply)) return meshError("bad_request", `No pending message ${key} for this peer.`);
		this.#dispatch(entry, reply);
		return meshOk({ accepted: true });
	}

	#accepts(entry: PendingEntry, reply: MeshIncomingReply): boolean {
		return (
			entry.op === reply.op &&
			(entry.peerInstanceId === MESH_ANY_INSTANCE || entry.peerInstanceId === reply.from.instanceId)
		);
	}

	#dispatch(entry: PendingEntry, reply: MeshIncomingReply): void {
		if (entry.waiter) {
			entry.waiter(reply);
			return;
		}
		if (entry.held && !entry.stored) {
			entry.stored = reply;
			return;
		}
		void this.#deliverLate(entry, reply);
	}

	async #request(
		to: string,
		fromAgentId: string,
		body: MeshRequest,
		options: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<MeshResponse> {
		if (this.#isBlocked(fromAgentId)) {
			return meshError("denied", "Mesh responders cannot send mesh requests.");
		}
		return this.#engine.request(to, fromAgentId, body, { timeoutMs: options.timeoutMs, signal: options.signal });
	}

	#isBlocked(agentId: string): boolean {
		const registry = AgentRegistry.global();
		const seen = new Set<string>();
		for (let id: string | undefined = agentId; id !== undefined && !seen.has(id); id = registry.get(id)?.parentId) {
			if (this.#blockedSenders.has(id)) return true;
			seen.add(id);
		}
		return false;
	}

	#track(
		op: PendingEntry["op"],
		key: string,
		peerInstanceId: string,
		agentId: string,
		held: boolean,
		/** Bound Main and its conversation when the request left; a rebind or switch during the round trip does not move it. */
		sent: { main: MeshDeliveryTarget; conversationId: string },
		ttlMs = PENDING_TTL_MS,
	): void {
		// The asking conversation was replaced while the request was in flight; nobody waits for this answer.
		if (agentId !== MESH_USER_AGENT_ID && sent.main.conversationId !== sent.conversationId) return;
		this.#prunePending();
		const entry: PendingEntry = {
			op,
			peerInstanceId,
			agentId,
			main: sent.main,
			conversationId: sent.conversationId,
			held,
			expiresAt: Date.now() + ttlMs,
		};
		this.#pending.set(key, entry);
		const early = this.#early.get(key);
		if (!early) return;
		this.#early.delete(key);
		if (early.expiresAt >= Date.now() && this.#accepts(entry, early.reply)) this.#dispatch(entry, early.reply);
	}

	#prunePending(): void {
		const now = Date.now();
		for (const [key, entry] of this.#pending) {
			if (entry.waiter) continue;
			// An agent's question dies with its closed session; the TUI user's keeps routing to the UI.
			const closed = entry.agentId !== MESH_USER_AGENT_ID && entry.main.isDisposed;
			if (closed || entry.expiresAt < now) this.#pending.delete(key);
		}
		// Oldest first: Map iteration follows insertion order.
		for (const [key, entry] of this.#pending) {
			if (this.#pending.size < MAX_PENDING) break;
			entry.waiter?.(undefined);
			this.#pending.delete(key);
		}
	}

	#pruneEarly(): void {
		const now = Date.now();
		for (const [key, early] of this.#early) {
			if (early.expiresAt < now) this.#early.delete(key);
		}
	}

	async #deliverLate(entry: PendingEntry, reply: MeshIncomingReply): Promise<void> {
		const { agentId, main, conversationId } = entry;
		try {
			if (agentId === MESH_USER_AGENT_ID) {
				if (this.#ui?.hasUI) {
					this.#ui.showIncoming(
						reply.from,
						reply.op === "reply"
							? {
									kind: "reply",
									text: reply.error ?? reply.text,
									thread: reply.thread,
									replyTo: reply.replyTo,
									error: reply.error !== undefined,
								}
							: { kind: "watch", text: reply.event },
					);
				} else {
					logger.debug("mesh: dropped a reply for the user without a UI", { from: reply.from.instanceId });
				}
				return;
			}
			// The asking session itself (Main, or an ACP top-level `acp:<sid>`) always takes the conversation check below.
			const target = agentId === MAIN_AGENT_ID ? main : this.#resolveAgent(agentId);
			if (target && target !== main && !target.isDisposed) {
				try {
					await target.deliverMeshMessage(lateMessage(reply, target));
					return;
				} catch (error) {
					logger.debug("mesh: subagent reply delivery failed; routing to Main", {
						agentId,
						error: toError(error).message,
					});
				}
			}
			// The asking conversation is gone (session closed, or `/new`/reset/resume replaced it); no other conversation asked this.
			if (main.isDisposed || main.conversationId !== conversationId) {
				logger.debug("mesh: dropped a reply for a conversation that ended", {
					agentId,
					from: reply.from.instanceId,
				});
				return;
			}
			await main.deliverMeshMessage(lateMessage(reply, main, target === main ? undefined : agentId));
		} catch (error) {
			logger.warn("mesh: late reply delivery failed", { agentId, error: toError(error).message });
		}
	}
}

function lateMessage(
	reply: MeshIncomingReply,
	target: MeshDeliveryTarget,
	originalAgent?: string,
): CustomMessagePayload {
	return reply.op === "reply"
		? buildMeshReplyMessage({
				from: reply.from,
				replyTo: reply.replyTo,
				thread: reply.thread,
				text: reply.text,
				error: reply.error,
				originalAgent,
				toolRefs: meshToolRefs(target.toolSession ?? {}),
			})
		: buildMeshWatchEventMessage({
				from: reply.from,
				watchId: reply.watchId,
				event: reply.event,
				detail: reply.detail,
				originalAgent,
			});
}
