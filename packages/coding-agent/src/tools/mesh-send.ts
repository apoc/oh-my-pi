import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { MeshEngineError } from "../mesh/engine";
import type { MeshIncomingReply } from "../mesh/outbound";
import { meshPeerLabel, resolveMeshPeer } from "../mesh/peers";
import { MAX_TEXT_CHARS, MAX_WATCH_TTL_SEC, type MeshErrorCode } from "../mesh/wire";
import meshSendDescription from "../prompts/tools/mesh-send.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { isMeshToolSession, meshToolRefs, requireMeshRuntime } from "../mesh/tool-refs";
import { meshPeerText } from "../mesh/text";
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

/** Default and maximum wait for a status/ask/task answer. */
export const MESH_SEND_DEFAULT_TIMEOUT_SEC = 300;
export const MESH_SEND_MAX_TIMEOUT_SEC = 1800;

export type MeshSendKind = "status" | "ask" | "task" | "steer" | "note" | "watch" | "reply";

/**
 * Approval tier per kind: reading a peer's state or notifying it is `write`; anything that makes
 * the peer act (steer its agent, run a task) or speaks for this agent (reply) is `exec`. Unknown
 * kinds fail closed.
 */
export function meshSendTier(kind: unknown): ToolApprovalDecision {
	return kind === "status" || kind === "ask" || kind === "watch" || kind === "note" ? "write" : "exec";
}

const meshSendSchema = type({
	to: type("string").describe("peer instance id, unique id prefix, or unique display/session name"),
	kind: type("'status' | 'ask' | 'task' | 'steer' | 'note' | 'watch' | 'reply'").describe("message kind"),
	"message?": type("string").describe("message text; required except for watch"),
	"thread?": type("string").describe("status/ask/task: continue this thread"),
	"replyTo?": type("string").describe("reply: msgId of the peer message answered"),
	"event?": type("'idle' | 'turn_end'").describe("watch: event to wait for"),
	"timeoutSec?": type("number > 0").describe(
		"status/ask/task: answer wait (default 300, max 1800); watch: lifetime (max 3600)",
	),
});

export type MeshSendParams = typeof meshSendSchema.infer;

export interface MeshSendDetails {
	kind: MeshSendKind;
	to: string;
	msgId?: string;
	thread?: string;
	watchId?: string;
	/** status/ask/task: whether the answer arrived before the wait ended. */
	answered?: boolean;
}

/** Refusal by the peer; its message is peer text. */
function refused(peer: string, code: MeshErrorCode, message: string): ToolError {
	return new ToolError(`${peer} refused: ${code}: ${meshPeerText(message)}`);
}

function argumentError(kind: MeshSendKind, problem: string): ToolError {
	return new ToolError(`mesh_send ${kind}: ${problem}`);
}

export class MeshSendTool implements AgentTool<typeof meshSendSchema, MeshSendDetails> {
	readonly name = "mesh_send";
	readonly label = "Mesh Send";
	readonly parameters = meshSendSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Message another omp instance: status, ask, task, steer, note, watch, reply";
	readonly approval = (args: unknown): ToolApprovalDecision => meshSendTier(isRecord(args) ? args.kind : undefined);
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	get description(): string {
		return prompt.render(meshSendDescription, { toolRefs: meshToolRefs(this.#session) });
	}

	static createIf(session: ToolSession): MeshSendTool | null {
		return isMeshToolSession(session) ? new MeshSendTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: MeshSendParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<MeshSendDetails>> {
		const { engine, frontend } = requireMeshRuntime(this.#session);
		const { kind } = params;
		const text = params.message ?? "";
		if (kind !== "watch" && text.trim().length === 0) throw argumentError(kind, "`message` is required.");
		if (text.length > MAX_TEXT_CHARS) throw argumentError(kind, `\`message\` exceeds ${MAX_TEXT_CHARS} characters.`);
		if (params.thread !== undefined && kind !== "status" && kind !== "ask" && kind !== "task") {
			throw argumentError(kind, "`thread` applies to status/ask/task only.");
		}
		if (kind === "reply" && !params.replyTo) throw argumentError(kind, "`replyTo` is required.");
		if (kind === "watch" && !params.event) throw argumentError(kind, "`event` (idle | turn_end) is required.");

		const resolution = resolveMeshPeer(engine.peers(), params.to);
		if (!resolution.ok) throw new ToolError(resolution.message);
		const peer = resolution.peer;
		const to = peer.instanceId;
		const label = meshPeerLabel(peer);
		// The engine drops everything a blocked peer sends, answers and watch events included.
		if (peer.blocked && kind !== "note") {
			throw new ToolError(`${label} is blocked: it cannot answer. Unblock it in /mesh first.`);
		}
		const fromAgentId = this.#session.getAgentId?.() ?? MAIN_AGENT_ID;
		const outbound = frontend.outbound;
		const details: MeshSendDetails = { kind, to };

		try {
			switch (kind) {
				case "watch": {
					// The wire carries whole seconds in 1..=MAX_WATCH_TTL_SEC.
					const ttlSec = Math.max(
						1,
						Math.min(Math.ceil(params.timeoutSec ?? MAX_WATCH_TTL_SEC), MAX_WATCH_TTL_SEC),
					);
					const result = await outbound.watch({ to, fromAgentId, event: params.event!, ttlSec, signal });
					if (!result.ok) throw refused(label, result.code, result.message);
					details.watchId = result.watchId;
					return done(
						`Watching ${label} for ${params.event} (watch ${meshPeerText(result.watchId)}, up to ${ttlSec}s). The event will arrive later as a message.`,
						details,
					);
				}
				case "reply": {
					const response = await outbound.reply({ to, fromAgentId, replyTo: params.replyTo!, text, signal });
					if (!response.ok) throw refused(label, response.code, response.message);
					return done(`Reply to ${params.replyTo} delivered to ${label}.`, details);
				}
				case "steer":
				case "note": {
					const result = await outbound.send({ to, fromAgentId, kind, text, signal });
					if (!result.ok) throw refused(label, result.code, result.message);
					details.msgId = result.msgId;
					const msgId = meshPeerText(result.msgId);
					return done(
						kind === "steer"
							? `Steer delivered to ${label} (msgId ${msgId}). A reply, if any, arrives later as a message.`
							: `Note accepted by ${label} (msgId ${msgId}); shown to its user, who may decline it.`,
						details,
					);
				}
				case "status":
				case "ask":
				case "task": {
					const timeoutSec = Math.min(
						params.timeoutSec ?? MESH_SEND_DEFAULT_TIMEOUT_SEC,
						MESH_SEND_MAX_TIMEOUT_SEC,
					);
					const result = await outbound.send({
						to,
						fromAgentId,
						kind,
						text,
						thread: params.thread,
						awaitReply: true,
						signal,
					});
					if (!result.ok) throw refused(label, result.code, result.message);
					details.msgId = result.msgId;
					details.thread = result.thread;
					const reply = await outbound.awaitReply(result.msgId, timeoutSec * 1000, signal);
					throwIfAborted(signal);
					details.answered = reply !== undefined;
					const threadNote = result.thread ? `thread ${meshPeerText(result.thread)}` : "no thread";
					if (!reply) {
						return done(
							`No answer from ${label} within ${timeoutSec}s (${threadNote}, msgId ${meshPeerText(result.msgId)}). The answer will arrive later as a message; do not resend.`,
							details,
						);
					}
					return done(answerText(label, threadNote, reply), details);
				}
			}
		} catch (error) {
			if (error instanceof MeshEngineError) {
				throwIfAborted(signal);
				throw new ToolError(`${label} unreachable: ${error.code}: ${meshPeerText(error.message)}`);
			}
			throw error;
		}
	}
}

function done(text: string, details: MeshSendDetails): AgentToolResult<MeshSendDetails> {
	return { content: [{ type: "text", text }], details };
}

function answerText(label: string, threadNote: string, reply: MeshIncomingReply): string {
	if (reply.op !== "reply") return `${label} reported ${reply.event} (${threadNote}).`;
	if (reply.error) return `${label} could not answer (${threadNote}): ${meshPeerText(reply.error)}`;
	return `Answer from ${label} (${threadNote}; pass thread to follow up):\n\n${meshPeerText(reply.text)}`;
}
