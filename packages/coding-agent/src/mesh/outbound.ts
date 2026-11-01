/**
 * Sender side of mesh messaging. Thread kinds and steers are acknowledged immediately and answered
 * later by a separate `reply` request; watches fire one `watch_event`. The engine correlates those
 * answers with their requests; this class decides who receives them: every tracked send carries a
 * ticket naming the local agent that sent it, and an answer nobody awaits is delivered late to that
 * agent. Main and live subagents get a hidden `mesh:reply` (or `mesh:watch`) message, a finished
 * subagent's answer goes to Main naming the agent, the TUI user's answer to the UI.
 */
import { logger, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { isLocalAgentSession } from "../session/agent-session-handle";
import type { CustomMessagePayload } from "../session/messages";
import {
	buildMeshReplyMessage,
	buildMeshWatchEventMessage,
	deliverMeshMessage,
	type MeshDeliveryTarget,
	type MeshUiHooks,
} from "./bridge";
import type { MeshEngine, MeshIncomingReply, MeshPeerView } from "./engine";
import { meshToolRefs } from "./tool-refs";
import type {
	MeshErrorCode,
	MeshMessageKind,
	MeshMessageResult,
	MeshRequest,
	MeshWatchEvent,
	MeshWatchResult,
} from "./wire";

/** `agentId` of messages the human sends from the TUI. */
export const MESH_USER_AGENT_ID = "user";

/** Maximum wait for a status/ask/task answer. */
export const MESH_SEND_MAX_TIMEOUT_SEC = 1800;

/**
 * A refused send: by the peer (its {@link MeshErrorCode}; peer text), or `blocked` here: this
 * instance drops everything a blocked peer sends, so nothing but a note goes to it.
 */
export type MeshRefusal = { ok: false; code: MeshErrorCode | "blocked"; message: string };

export type MeshSendResult = { ok: true; msgId: string; thread?: string } | MeshRefusal;

export type MeshWatchSendResult = { ok: true; watchId: string } | MeshRefusal;

export type MeshOutboundResponse = { ok: true; data: unknown } | MeshRefusal;

/** The recipient, as the caller resolved it from the peer table. */
export type MeshSendTarget = Pick<MeshPeerView, "instanceId" | "blocked">;

/** Who receives the answers to one tracked send. */
interface Ticket {
	agentId: string;
	/** Main session bound when the message was sent: late answers go there, never to a later rebind. */
	main: MeshDeliveryTarget;
	/** `main.conversationId` at send time; a later `/new`, context reset, resume or fork there makes the answer stale. */
	conversationId: string;
	/** The peer acknowledged the send. */
	acked: boolean;
	/** TUI user sends: told about a late answer after its card is shown. */
	onLate?: (reply: MeshIncomingReply) => void;
}

interface TrackedOptions {
	/** An {@link MeshOutbound.awaitReply} call follows: an early answer is kept for it. */
	awaitReply?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** TUI user sends: called with an answer nobody awaits any more. */
	onLate?: (reply: MeshIncomingReply) => void;
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
	/** Tickets the engine may name in a reply event; minted before the request leaves. */
	readonly #tickets = new Map<string, Ticket>();
	readonly #unsubscribe: (() => void)[];

	constructor(options: MeshOutboundOptions) {
		this.#engine = options.engine;
		this.#main = options.main;
		this.#ui = options.ui;
		this.#resolveAgent = options.resolveAgent ?? liveRegistrySession;
		this.#unsubscribe = [
			this.#engine.onReply((ticket, reply) => this.#onReply(ticket, reply)),
			this.#engine.onPendingDropped(tickets => {
				for (const ticket of tickets) this.#tickets.delete(ticket);
			}),
		];
	}

	/** Main session for messages sent from now on (host rebinding the mesh); earlier sends keep their own. */
	setMain(main: MeshDeliveryTarget): void {
		this.#main = main;
	}

	/** Engine stop: forget every tracked send (their waits resolve `undefined`). */
	dispose(): void {
		for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
		this.#engine.forgetPending([...this.#tickets.keys()]);
		this.#tickets.clear();
	}

	/**
	 * Send a `message`. Replies to it (thread kinds and steers) route back to `fromAgentId`.
	 * Transport failures reject with `MeshEngineError`.
	 */
	async send(
		args: TrackedOptions & {
			to: MeshSendTarget;
			fromAgentId: string;
			kind: MeshMessageKind;
			text: string;
			thread?: string;
		},
	): Promise<MeshSendResult> {
		const body: MeshRequest = {
			op: "message",
			kind: args.kind,
			text: args.text,
			...(args.thread ? { thread: args.thread } : {}),
		};
		// Notes are for the peer's human: nothing answers them, not even a declined approval.
		const response =
			args.kind === "note"
				? await this.#request(args.to, args.fromAgentId, body, args)
				: await this.#tracked(args.to, args.fromAgentId, body, args);
		if (!response.ok) return response;
		// The engine validated the acknowledgement (`msgId`, `thread`).
		const { msgId, thread } = response.data as MeshMessageResult;
		return { ok: true, msgId, ...(thread !== undefined ? { thread } : {}) };
	}

	/** Register a one-shot watch on the peer; its event routes like a reply, keyed by `watchId`. */
	async watch(
		args: TrackedOptions & { to: MeshSendTarget; fromAgentId: string; event: MeshWatchEvent; ttlSec: number },
	): Promise<MeshWatchSendResult> {
		const response = await this.#tracked(
			args.to,
			args.fromAgentId,
			{ op: "watch", event: args.event, ttlSec: args.ttlSec },
			args,
		);
		if (!response.ok) return response;
		return { ok: true, watchId: (response.data as MeshWatchResult).watchId };
	}

	/** Answer a peer's message (`replyTo` = its msgId), e.g. Main replying to a steer. */
	reply(args: {
		to: MeshSendTarget;
		fromAgentId: string;
		replyTo: string;
		thread?: string;
		text: string;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<MeshOutboundResponse> {
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
		return this.#engine.awaitReply(key, timeoutMs, signal);
	}

	/** A send whose answers the engine tracks under a ticket minted here first, so every event names a known ticket. */
	async #tracked(
		to: MeshSendTarget,
		fromAgentId: string,
		body: MeshRequest,
		options: TrackedOptions,
	): Promise<MeshOutboundResponse> {
		this.#pruneClosedSessions();
		const main = this.#main;
		const ticket = Snowflake.next();
		const entry: Ticket = {
			agentId: fromAgentId,
			main,
			conversationId: main.conversationId,
			acked: false,
			onLate: options.onLate,
		};
		this.#tickets.set(ticket, entry);
		let response: MeshOutboundResponse;
		try {
			response = await this.#request(to, fromAgentId, body, {
				...options,
				ticket,
				hold: options.awaitReply === true,
			});
		} catch (error) {
			this.#forget(ticket);
			throw error;
		}
		if (!response.ok) {
			// Nothing was tracked for a refused send.
			this.#tickets.delete(ticket);
			return response;
		}
		entry.acked = true;
		// The asking conversation was replaced, or its session closed and was pruned, while the request
		// was in flight; nobody waits for this answer. Forgetting tells the engine, which tracked it on the ack.
		if (!this.#tickets.has(ticket) || this.#isStale(entry)) this.#forget(ticket);
		return response;
	}

	async #request(
		to: MeshSendTarget,
		fromAgentId: string,
		body: MeshRequest,
		options: { timeoutMs?: number; signal?: AbortSignal; ticket?: string; hold?: boolean },
	): Promise<MeshOutboundResponse> {
		// The engine drops everything a blocked peer sends, answers and watch events included.
		if (to.blocked && (body.op !== "message" || body.kind !== "note")) {
			return { ok: false, code: "blocked", message: "it cannot answer. Unblock it in /mesh first." };
		}
		return this.#engine.request(to.instanceId, fromAgentId, body, {
			timeoutMs: options.timeoutMs,
			signal: options.signal,
			ticket: options.ticket,
			hold: options.hold,
		});
	}

	/** An agent's send whose conversation was replaced; the TUI user's keeps routing to the UI. */
	#isStale(entry: Ticket): boolean {
		return entry.agentId !== MESH_USER_AGENT_ID && entry.main.conversationId !== entry.conversationId;
	}

	#forget(ticket: string): void {
		this.#tickets.delete(ticket);
		this.#engine.forgetPending([ticket]);
	}

	/** An agent's question dies with its closed session; the TUI user's keeps routing to the UI. */
	#pruneClosedSessions(): void {
		const closed: string[] = [];
		for (const [ticket, entry] of this.#tickets) {
			if (entry.agentId !== MESH_USER_AGENT_ID && entry.main.isDisposed) closed.push(ticket);
		}
		if (closed.length === 0) return;
		for (const ticket of closed) this.#tickets.delete(ticket);
		this.#engine.forgetPending(closed);
	}

	#onReply(ticket: string, reply: MeshIncomingReply): void {
		const entry = this.#tickets.get(ticket);
		if (!entry) {
			logger.debug("mesh: dropped an answer to a forgotten send", { from: reply.from.instanceId });
			return;
		}
		// An answer that overtook its acknowledgement: apply the in-flight conversation check now.
		if (!entry.acked && this.#isStale(entry)) {
			this.#forget(ticket);
			return;
		}
		void this.#deliverLate(entry, reply);
	}

	async #deliverLate(entry: Ticket, reply: MeshIncomingReply): Promise<void> {
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
									error: reply.error !== undefined,
								}
							: { kind: "watch", text: reply.event },
					);
				} else {
					logger.debug("mesh: dropped a reply for the user without a UI", { from: reply.from.instanceId });
				}
				entry.onLate?.(reply);
				return;
			}
			// The asking session itself (Main, or an ACP top-level `acp:<sid>`) always takes the conversation check below.
			const target = agentId === MAIN_AGENT_ID ? main : this.#resolveAgent(agentId);
			if (target && target !== main && !target.isDisposed) {
				try {
					await deliverMeshMessage(target, lateMessage(reply, target));
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
			await deliverMeshMessage(main, lateMessage(reply, main, target === main ? undefined : agentId));
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
