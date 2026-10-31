import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { raceJobSettlement, resolveAutoBackgroundWaitMs } from "../async";
import { MeshEngineError } from "../mesh/engine";
import type { MeshIncomingReply, MeshOutbound } from "../mesh/outbound";
import { meshPeerLabel, resolveMeshPeer } from "../mesh/peers";
import { cfgMeshAutoBackgroundEnabled, cfgMeshAutoBackgroundThresholdMs } from "../mesh/settings";
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
	/** status/ask/task: whether the answer arrived before the call returned. */
	answered?: boolean;
	/** status/ask/task: background job still waiting for the answer (`mesh.autoBackground`). */
	jobId?: string;
}

/** A sent status/ask/task whose answer the call waits for. */
interface PendingAnswer {
	kind: MeshSendKind;
	label: string;
	text: string;
	msgId: string;
	threadNote: string;
	timeoutSec: number;
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
		const settings = this.#session.settings;
		return prompt.render(meshSendDescription, {
			toolRefs: meshToolRefs(this.#session),
			autoBackgroundEnabled: cfgMeshAutoBackgroundEnabled.get(settings),
			autoBackgroundSeconds: Math.max(0, cfgMeshAutoBackgroundThresholdMs.get(settings)) / 1000,
		});
	}

	static createIf(session: ToolSession): MeshSendTool | null {
		return isMeshToolSession(session) ? new MeshSendTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: MeshSendParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<MeshSendDetails>,
		ctx?: AgentToolContext,
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
					const pending: PendingAnswer = {
						kind,
						label,
						text,
						msgId: result.msgId,
						threadNote: result.thread ? `thread ${meshPeerText(result.thread)}` : "no thread",
						timeoutSec,
					};
					// Every path from here reaches `awaitReply`: a held answer is never stranded.
					return await this.#awaitAnswer(outbound, pending, details, signal, ctx?.toolCall?.steeringSignal);
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

	/**
	 * Wait for the answer to a sent status/ask/task. With `mesh.autoBackground` on, the wait runs
	 * as a `mesh` job: the call returns the answer if it lands within the threshold, else hands the
	 * job to the background (early when a user message queues) so the agent can keep working; the
	 * job's completion is delivered as a follow-up message that wakes the agent.
	 */
	async #awaitAnswer(
		outbound: MeshOutbound,
		pending: PendingAnswer,
		details: MeshSendDetails,
		signal: AbortSignal | undefined,
		steeringSignal: AbortSignal | undefined,
	): Promise<AgentToolResult<MeshSendDetails>> {
		const settings = this.#session.settings;
		const manager = this.#session.asyncJobManager;
		const timeoutMs = pending.timeoutSec * 1000;
		const thresholdMs = Math.max(0, Math.floor(cfgMeshAutoBackgroundThresholdMs.get(settings)));
		// A wait no longer than the threshold never backgrounds; at the job cap the call waits inline.
		if (!cfgMeshAutoBackgroundEnabled.get(settings) || !manager || manager.atCapacity || timeoutMs <= thresholdMs) {
			const reply = await outbound.awaitReply(pending.msgId, timeoutMs, signal);
			throwIfAborted(signal);
			return answerResult(pending, reply, details);
		}

		const waitMs = resolveAutoBackgroundWaitMs(thresholdMs, timeoutMs);
		const settled = Promise.withResolvers<{ kind: "settled"; reply: MeshIncomingReply | undefined }>();
		// `register` runs the body synchronously up to its first await, so the waiter is in place
		// before any answer stored for this msgId could be missed.
		const jobId = manager.register(
			"mesh",
			jobLabel(pending),
			async ({ jobId: ownId, signal: jobSignal }) => {
				const reply = await outbound.awaitReply(pending.msgId, timeoutMs, jobSignal);
				settled.resolve({ kind: "settled", reply });
				if (reply) return answerText(pending, reply);
				// Out of time: a later answer still arrives as a mesh reply message, so this job ends
				// without a delivery of its own instead of waking the agent with nothing to report.
				if (!jobSignal.aborted) manager.cancel(ownId);
				return noAnswerText(pending);
			},
			{ ownerId: this.#session.getAgentId?.() ?? undefined, foreground: waitMs > 0 },
		);

		let steered = false;
		if (waitMs > 0) {
			const waited = await raceJobSettlement(settled.promise, waitMs, signal, steeringSignal);
			if (waited.kind === "settled") {
				manager.releaseForegroundJob(jobId);
				return answerResult(pending, waited.reply, details);
			}
			if (waited.kind === "aborted") {
				manager.cancel(jobId);
				manager.releaseForegroundJob(jobId);
				throwIfAborted(signal);
			}
			steered = waited.kind === "steer";
			manager.backgroundJob(jobId);
		}
		details.answered = false;
		details.jobId = jobId;
		return done(backgroundText(pending, jobId, steered), details);
	}
}

function done(text: string, details: MeshSendDetails): AgentToolResult<MeshSendDetails> {
	return { content: [{ type: "text", text }], details };
}

/** The call's result once the wait ended inline: the answer, or where it will arrive instead. */
function answerResult(
	pending: PendingAnswer,
	reply: MeshIncomingReply | undefined,
	details: MeshSendDetails,
): AgentToolResult<MeshSendDetails> {
	details.answered = reply !== undefined;
	return done(reply ? answerText(pending, reply) : noAnswerText(pending), details);
}

function answerText(pending: PendingAnswer, reply: MeshIncomingReply): string {
	const { label, threadNote } = pending;
	if (reply.op !== "reply") return `${label} reported ${reply.event} (${threadNote}).`;
	if (reply.error) return `${label} could not answer (${threadNote}): ${meshPeerText(reply.error)}`;
	return `Answer from ${label} (${threadNote}; pass thread to follow up):\n\n${meshPeerText(reply.text)}`;
}

function noAnswerText(pending: PendingAnswer): string {
	return `No answer from ${pending.label} within ${pending.timeoutSec}s (${pending.threadNote}, msgId ${meshPeerText(pending.msgId)}). The answer will arrive later as a message; do not resend.`;
}

function backgroundText(pending: PendingAnswer, jobId: string, steered: boolean): string {
	const lead = steered
		? "Moved to the background early to handle an incoming message."
		: `No answer from ${pending.label} yet.`;
	return `${lead} Background job ${jobId} waits up to ${pending.timeoutSec}s (${pending.threadNote}, msgId ${meshPeerText(pending.msgId)}); the answer arrives automatically as a follow-up message. If none comes by then, the job ends silently and a later answer still arrives as a mesh reply. Continue with other work; do not resend or poll.`;
}

/** Job-row label: kind, peer, and the first line of the question. */
function jobLabel(pending: PendingAnswer): string {
	const label = `${pending.kind} → ${pending.label}: ${pending.text.trim().split("\n", 1)[0] ?? ""}`;
	return label.length > 120 ? `${label.slice(0, 117)}...` : label;
}
