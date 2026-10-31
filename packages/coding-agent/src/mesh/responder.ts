/**
 * Answers inbound thread questions. `status` is an ephemeral side turn over the main context (no
 * tools); `ask` runs a read-only `mesh-responder` fork of the main session that may delegate to
 * read-only `scout` subagents, continued for follow-ups while the main leaf is unchanged; `task`
 * runs the bundled `task` agent (which may spawn any subagent) with a fresh context in the main cwd.
 * Responders and their subagents never get mesh tools, so mesh-triggered work cannot send mesh requests.
 */
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import meshResponderMd from "../prompts/agents/mesh-responder.md" with { type: "text" };
import meshAskAssignmentTemplate from "../prompts/system/mesh-ask-assignment.md" with { type: "text" };
import meshFollowupTemplate from "../prompts/system/mesh-followup.md" with { type: "text" };
import meshStatusUserTemplate from "../prompts/system/mesh-status-user.md" with { type: "text" };
import meshTaskAssignmentTemplate from "../prompts/system/mesh-task-assignment.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, isResumable } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { runBtwTurn } from "../session/btw-turn";
import { meshPeerText } from "./text";
import { getBundledAgent, parseAgent } from "../task/agents";
import { runSubagentFollowUpTurn } from "../task/executor";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { AgentDefinition } from "../task/types";
import type { HostRestrictions } from "../task/host-restrictions";
import { type MeshAnswerer, MeshPeerError, type MeshResponderResult } from "./inbound";
import { isMeshThreadResponder, meshResponderArtifactsDir } from "./paths";
import { decideAskRoute, type MeshThreadRecord, meshConversationKey, meshThreadHistory } from "./threads";

let meshResponderAgent: AgentDefinition | undefined;

/** Parsed once; deliberately not a bundled agent, so the `task` roster never offers it. */
function getMeshResponderAgent(): AgentDefinition {
	meshResponderAgent ??= parseAgent("embedded:mesh-responder.md", prompt.render(meshResponderMd), "bundled");
	return meshResponderAgent;
}

function assertNoMeshTools(agent: AgentDefinition): void {
	if (agent.tools?.some(tool => tool.startsWith("mesh_"))) {
		throw new Error(`Mesh responder agent "${agent.name}" must not carry mesh tools.`);
	}
}

const MESH_ASK_RESTRICTIONS: HostRestrictions = { "fetch.enabled": false, "web_search.enabled": false };

/** The child's answer; failure details (local paths, salvage hints) stay in the local log. */
function resultText(result: SingleResult): string {
	if (result.aborted) throw new MeshPeerError("The responder was cancelled.");
	if (result.exitCode !== 0 || result.error) {
		logger.warn("mesh: responder failed", {
			id: result.id,
			exitCode: result.exitCode,
			error: result.error || result.stderr,
		});
		throw new MeshPeerError("The responder failed to produce an answer.");
	}
	return result.output;
}

function replayHistory(record: MeshThreadRecord, turnIndex: number) {
	return meshThreadHistory(record, turnIndex).map(turn => ({
		question: meshPeerText(turn.question),
		answer: meshPeerText(turn.answer ?? ""),
	}));
}

export class MeshResponder implements MeshAnswerer {
	readonly #session: AgentSession;

	constructor(session: AgentSession) {
		this.#session = session;
	}

	/** Answer `record.turns[turnIndex]`; throws when no answer could be produced. */
	answer(record: MeshThreadRecord, turnIndex: number, signal: AbortSignal): Promise<MeshResponderResult> {
		switch (record.kind) {
			case "status":
				return this.#answerStatus(record, turnIndex, signal);
			case "ask":
				return this.#answerAsk(record, turnIndex, signal);
			case "task":
				return this.#answerTask(record, turnIndex, signal);
		}
	}

	async #answerStatus(record: MeshThreadRecord, turnIndex: number, signal: AbortSignal): Promise<MeshResponderResult> {
		const from = meshPeerText(record.peer.displayName);
		const { replyText } = await runBtwTurn(this.#session, {
			question: record.turns[turnIndex]!.question,
			history: meshThreadHistory(record, turnIndex).map(turn => ({
				question: turn.question,
				answer: turn.answer ?? "",
				status: "complete",
				createdAt: turn.createdAt,
				updatedAt: turn.updatedAt,
			})),
			conversationKey: meshConversationKey(record, turnIndex),
			onTextDelta: () => {},
			signal,
			renderQuestion: question => prompt.render(meshStatusUserTemplate, { from, question: meshPeerText(question) }),
		});
		return { text: replyText };
	}

	async #answerAsk(record: MeshThreadRecord, turnIndex: number, signal: AbortSignal): Promise<MeshResponderResult> {
		const agent = getMeshResponderAgent();
		const sessionManager = this.#session.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const forkAgentId = record.forkAgentId;
		const route = decideAskRoute({
			forkAgentId,
			forkLeafId: record.forkLeafId,
			mainLeafId: sessionManager.getLeafId(),
			forkResumable: this.#isResumableResponder(record),
		});
		if (route === "continue" && forkAgentId !== undefined) {
			const text = await this.#continue(forkAgentId, agent, record, turnIndex, signal);
			if (text !== undefined) return { text, responder: { forkAgentId, forkLeafId: record.forkLeafId } };
		}

		const sourceFile = await this.#persistMainSession();
		// The awaits above can straddle a session switch; never fork the conversation that replaced the asked one.
		if (sessionManager.getSessionId() !== sessionId) {
			throw new MeshPeerError(`thread_expired: thread ${record.threadId} expired before it could be answered.`);
		}
		// Read after the flush, before the fork reads the file. Entries main appends while the child
		// spawns only make the child newer than this leaf, so the next follow-up re-forks; it never
		// continues a fork that is missing context.
		const forkLeafId = sessionManager.getLeafId();
		const result = await this.#spawn(
			agent,
			meshAskAssignmentTemplate,
			"MeshAsk",
			record,
			turnIndex,
			signal,
			sourceFile,
		);
		return { text: resultText(result), responder: { forkAgentId: result.id, forkLeafId } };
	}

	async #answerTask(record: MeshThreadRecord, turnIndex: number, signal: AbortSignal): Promise<MeshResponderResult> {
		const agent = getBundledAgent("task");
		if (!agent) throw new MeshPeerError("Tasks are unavailable on this instance.");
		const forkAgentId = record.forkAgentId;
		if (forkAgentId !== undefined && this.#isResumableResponder(record)) {
			const text = await this.#continue(forkAgentId, agent, record, turnIndex, signal);
			if (text !== undefined) return { text, responder: { forkAgentId } };
		}
		const result = await this.#spawn(agent, meshTaskAssignmentTemplate, "MeshTask", record, turnIndex, signal);
		return { text: resultText(result), responder: { forkAgentId: result.id } };
	}

	/** One more turn on a kept-alive responder; `undefined` when it cannot be revived (caller respawns). */
	async #continue(
		id: string,
		agent: AgentDefinition,
		record: MeshThreadRecord,
		turnIndex: number,
		signal: AbortSignal,
	): Promise<string | undefined> {
		try {
			await AgentLifecycleManager.global().ensureLive(id);
		} catch (error) {
			logger.debug("mesh: responder not revivable; respawning", { id, error: String(error) });
			return undefined;
		}
		const result = await runSubagentFollowUpTurn({
			id,
			agent,
			message: prompt.render(meshFollowupTemplate, {
				from: meshPeerText(record.peer.displayName),
				question: meshPeerText(record.turns[turnIndex]!.question),
			}),
			structured: false,
			artifactsDir: this.#responderDir(record.threadId),
			signal,
		});
		return resultText(result);
	}

	/** Spawn a responder for `record`'s turn `turnIndex`, assigned through `template` with the peer's text sanitized. */
	async #spawn(
		agent: AgentDefinition,
		template: string,
		label: string,
		record: MeshThreadRecord,
		turnIndex: number,
		signal: AbortSignal,
		forkSourceFile?: string,
	): Promise<SingleResult> {
		assertNoMeshTools(agent);
		const toolSession = this.#session.toolSession;
		if (!toolSession) throw new MeshPeerError("This instance cannot run mesh responders.");
		const artifactsDir = this.#responderDir(record.threadId);
		const { result } = await runStructuredSubagent({
			session: toolSession,
			invocationKind: "task",
			assignment: prompt.render(template, {
				from: meshPeerText(record.peer.displayName),
				host: meshPeerText(record.peer.host),
				history: replayHistory(record, turnIndex),
				question: meshPeerText(record.turns[turnIndex]!.question),
			}),
			agentDefinition: agent,
			// A peer-triggered read-only fork must not become a URL fetcher (localhost, LAN) or a web
			// search proxy; the restrictions bind every scout it spawns, which stays seance-confined too.
			...(forkSourceFile ? { fork: { sourceFile: forkSourceFile, hostRestrictions: MESH_ASK_RESTRICTIONS } } : {}),
			...(artifactsDir ? { artifactsDir } : {}),
			structured: false,
			keepAlive: true,
			enableIrc: false,
			identity: { label },
			signal,
		});
		return result;
	}

	/** Responder root under main's private `mesh-threads/`; absent for in-memory sessions (temporary artifacts). */
	#responderDir(threadId: string): string | undefined {
		const artifactsDir = this.#session.sessionManager.getArtifactsDir();
		return artifactsDir === null ? undefined : meshResponderArtifactsDir(artifactsDir, threadId);
	}

	/**
	 * The thread's kept responder can take another turn: resumable, and its transcript sits in this
	 * thread's own folder. Ids restart after a process restart, so a reloaded thread's id may now name
	 * another thread's responder. In-memory sessions never reload threads, so in-process ids suffice.
	 */
	#isResumableResponder(record: MeshThreadRecord): boolean {
		if (record.forkAgentId === undefined) return false;
		const ref = AgentRegistry.global().get(record.forkAgentId);
		if (!isResumable(ref)) return false;
		const artifactsDir = this.#session.sessionManager.getArtifactsDir();
		return artifactsDir === null || isMeshThreadResponder(ref?.sessionFile, artifactsDir, record.threadId);
	}

	/** Settle and flush main so its session file holds every committed entry; returns that file. */
	async #persistMainSession(): Promise<string> {
		const sessionManager = this.#session.sessionManager;
		await this.#session.settleInFlightMessagePersistence();
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile || !(await Bun.file(sessionFile).exists())) {
			throw new MeshPeerError("Asks need a persisted session; this session is in-memory.");
		}
		return sessionFile;
	}
}
