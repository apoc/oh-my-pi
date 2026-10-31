/**
 * Delivery of mesh traffic into an agent session as custom messages. Every peer-supplied string
 * is harness-tag escaped before it is rendered into the envelope; `details` keep the raw values
 * for transcript rendering.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import meshIncomingTemplate from "../prompts/system/mesh-incoming.md" with { type: "text" };
import meshReplyTemplate from "../prompts/system/mesh-reply.md" with { type: "text" };
import meshWatchEventTemplate from "../prompts/system/mesh-watch-event.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import type { CustomMessagePayload } from "../session/messages";
import type { ToolSession } from "../tools";
import type { MeshToolName } from "./tool-refs";
import { meshPeerText } from "./text";
import type { MeshSender, MeshWatchEvent } from "./wire";

/** How the recipient's prompts name the mesh tools (`meshToolRefs`). */
export type MeshToolRefs = Record<MeshToolName, string>;

export const MESH_INCOMING_MESSAGE_TYPE = "mesh:incoming";
export const MESH_REPLY_MESSAGE_TYPE = "mesh:reply";
export const MESH_WATCH_MESSAGE_TYPE = "mesh:watch";

/** A session that accepts mesh messages ({@link AgentSession.deliverMeshMessage}). */
export interface MeshDeliveryTarget {
	readonly isDisposed: boolean;
	/** Current conversation; changes on `/new`, context reset, resume and fork (not on a same-file reload), making older answers stale. */
	readonly conversationId: string;
	/** The recipient's tool context; decides how reply instructions name `mesh_send`. */
	readonly toolSession?: Pick<ToolSession, "xdev">;
	deliverMeshMessage(message: CustomMessagePayload): Promise<"injected" | "woken">;
}

/** Human-facing mesh surface, implemented by the interactive TUI; absent or `hasUI: false` when headless. */
export interface MeshUiHooks {
	readonly hasUI: boolean;
	/** A peer's `note`: shown to the human, never to the agent. */
	showNote(from: MeshSender, text: string): void;
	/** A reply to a message the user sent from the TUI. */
	showReply(from: MeshSender, text: string, thread?: string): void;
	/** The approval queue (`MeshFrontend.approvals`) gained an entry. */
	notifyApproval(): void;
}

/**
 * `aside` delivery is the non-interrupting step-boundary queue while streaming; when idle it starts
 * an agent-initiated turn, except in plan mode or after a user interrupt (folded into context) and
 * on ACP clients that defer agent-initiated turns (queued for the next turn).
 */
export async function deliverMeshMessage(
	session: Pick<AgentSession, "isDisposed" | "sendCustomMessage">,
	message: CustomMessagePayload,
): Promise<"injected" | "woken"> {
	if (session.isDisposed) throw new Error("Recipient session is disposed.");
	const started = await session.sendCustomMessage(message, { deliverAs: "aside" });
	return started ? "woken" : "injected";
}

function senderFields(from: MeshSender) {
	return {
		from: meshPeerText(from.displayName),
		instanceId: meshPeerText(from.instanceId),
		host: meshPeerText(from.host),
		agent: meshPeerText(from.agentId),
	};
}

/** A peer `steer` for the main agent, with reply instructions keyed to the request's `msgId`. */
export function buildMeshIncomingMessage(args: {
	from: MeshSender;
	msgId: string;
	text: string;
	toolRefs: MeshToolRefs;
}): CustomMessagePayload {
	return {
		customType: MESH_INCOMING_MESSAGE_TYPE,
		content: prompt.render(meshIncomingTemplate, {
			...senderFields(args.from),
			msgId: meshPeerText(args.msgId),
			message: meshPeerText(args.text),
			toolRefs: args.toolRefs,
		}),
		display: true,
		details: { kind: "steer", from: args.from, msgId: args.msgId, message: args.text },
		attribution: "agent",
	};
}

/** A peer's answer that arrived after the asking agent stopped waiting; hidden from the transcript. */
export function buildMeshReplyMessage(args: {
	from: MeshSender;
	replyTo: string;
	thread?: string;
	text: string;
	error?: string;
	/** Asking agent the reply was meant for, when it is delivered elsewhere. */
	originalAgent?: string;
	toolRefs: MeshToolRefs;
}): CustomMessagePayload {
	return {
		customType: MESH_REPLY_MESSAGE_TYPE,
		content: prompt.render(meshReplyTemplate, {
			...senderFields(args.from),
			replyTo: meshPeerText(args.replyTo),
			thread: args.thread ? meshPeerText(args.thread) : "",
			message: meshPeerText(args.text),
			error: args.error ? meshPeerText(args.error) : "",
			originalAgent: args.originalAgent ? meshPeerText(args.originalAgent) : "",
			toolRefs: args.toolRefs,
		}),
		display: false,
		details: {
			kind: "reply",
			from: args.from,
			replyTo: args.replyTo,
			...(args.thread ? { thread: args.thread } : {}),
			message: args.text,
			...(args.error ? { error: args.error } : {}),
			...(args.originalAgent ? { originalAgent: args.originalAgent } : {}),
		},
		attribution: "agent",
	};
}

/** A watched peer's lifecycle event that arrived after the watching agent stopped waiting. */
export function buildMeshWatchEventMessage(args: {
	from: MeshSender;
	watchId: string;
	event: MeshWatchEvent;
	detail?: string;
	originalAgent?: string;
}): CustomMessagePayload {
	return {
		customType: MESH_WATCH_MESSAGE_TYPE,
		content: prompt.render(meshWatchEventTemplate, {
			...senderFields(args.from),
			watchId: meshPeerText(args.watchId),
			event: args.event,
			detail: args.detail ? meshPeerText(args.detail) : "",
			originalAgent: args.originalAgent ? meshPeerText(args.originalAgent) : "",
		}),
		display: false,
		details: {
			kind: "watch_event",
			from: args.from,
			watchId: args.watchId,
			event: args.event,
			...(args.detail ? { detail: args.detail } : {}),
			...(args.originalAgent ? { originalAgent: args.originalAgent } : {}),
		},
		attribution: "agent",
	};
}
