/**
 * One-paragraph smol-model summary of what this session is working on, served
 * in the mesh snapshot. The first one waits until the session made
 * {@link SUMMARY_MIN_TURNS} model turns, so it describes real work; it is then
 * regenerated after a terminal `agent_end` once the conversation advanced (a new
 * operator turn and at least {@link SUMMARY_MIN_INTERVAL_MS} since the last attempt), persisted beside the
 * session so a restart reuses it. Background work only: it never blocks or
 * fails the main turn.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { withCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { isEnoent, isRecord, logger, prompt, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import meshSummarySystemPrompt from "../prompts/system/mesh-summary.md" with { type: "text" };
import meshSummaryUserTemplate from "../prompts/system/mesh-summary-user.md" with { type: "text" };
import { cfgSecretsEnabled } from "../secrets/settings";
import type { AgentSession } from "../session/agent-session";
import { operatorTitleText } from "../session/messages";
import { buildSessionMetadata } from "../session/session-metadata";
import { cleanTinyMessage } from "../tiny/message-preproc";
import { writeFileAtomically } from "../utils/atomic-file";
import {
	completeWithBackgroundModels,
	selectBackgroundModels,
	stripLeakedThinkingMarkup,
} from "../utils/smol-completion";
import { cfgMeshEnabled, cfgMeshSummary } from "./settings";

export interface MeshSummaryState {
	text: string;
	updatedAt: number;
}

/** Minimum spacing between summary attempts. */
export const SUMMARY_MIN_INTERVAL_MS = 2 * 60_000;
/** Model turns (completed assistant replies) before the first summary: earlier ones say too little. */
export const SUMMARY_MIN_TURNS = 3;
/** Hard cap on the published summary. */
export const MAX_SUMMARY_CHARS = 400;

/** Inputs to {@link shouldRegenerateSummary}; timestamps in epoch ms. */
export interface SummaryTriggerState {
	/** Last generation attempt (or the loaded summary's time); `null` before the first. */
	lastAttemptAt: number | null;
	/** Newest operator turn the current summary covers; `null` when none exists. */
	summarizedUserTurnAt: number | null;
	/** Newest operator turn in the conversation; `null` when the user has not spoken. */
	latestUserTurnAt: number | null;
	/** Completed model turns in the conversation. */
	turns: number;
}

/**
 * Whether a settled turn should refresh the summary: the user must have spoken
 * since the covered turn; the first summary waits for `minTurns` model turns and
 * then runs right away, later ones only once `minIntervalMs` passed since the last attempt.
 */
export function shouldRegenerateSummary(
	state: SummaryTriggerState,
	now: number,
	minIntervalMs: number = SUMMARY_MIN_INTERVAL_MS,
	minTurns: number = SUMMARY_MIN_TURNS,
): boolean {
	if (state.latestUserTurnAt === null) return false;
	if (state.summarizedUserTurnAt === null && state.turns < minTurns) return false;
	if (state.summarizedUserTurnAt !== null && state.latestUserTurnAt <= state.summarizedUserTurnAt) return false;
	if (state.lastAttemptAt === null) return true;
	return now - state.lastAttemptAt >= minIntervalMs;
}

export interface MeshSummaryGeneratorOptions {
	/** Spacing between attempts; defaults to {@link SUMMARY_MIN_INTERVAL_MS}. */
	minIntervalMs?: number;
	/** Model turns before the first summary; defaults to {@link SUMMARY_MIN_TURNS}. */
	minTurns?: number;
}

const SUMMARY_FILE = "mesh-summary.json";
const SUMMARY_SYSTEM_PROMPT = prompt.render(meshSummarySystemPrompt);
// Generous like the title ceiling: backends that ignore `disableReasoning`
// spend output on thinking before the visible summary.
const SUMMARY_MAX_TOKENS = 1024;
const MAX_REQUESTS = 8;
const MAX_REQUEST_CHARS = 600;
const MAX_ASSISTANT_CHARS = 1200;
const MAX_TODO_TASKS = 20;
const MAX_NAME_CHARS = 200;

/** A closing thinking tag whose opener the chat template supplied (Qwen3-style). */
const ORPHAN_THINKING_CLOSE_RE = /^[\s\S]*<\/(?:think|thinking|reasoning)>/i;
const TAG_RE = /<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g;
const LINE_MARKER_RE = /^\s*(?:#+|>|[-*•]|\d+[.)])\s+/gm;
const EMPHASIS_RE = /`+|\*\*|__/g;

interface PersistedSummary {
	v: 1;
	sessionId: string;
	text: string;
	updatedAt: number;
	userTurnAt: number | null;
}

type SummaryListener = (summary: MeshSummaryState | null) => void;

export class MeshSummaryGenerator {
	readonly #minIntervalMs: number;
	readonly #minTurns: number;
	#session: AgentSession | null = null;
	/** Session-manager id the state below belongs to. */
	#sessionId: string | null = null;
	#summary: MeshSummaryState | null = null;
	#trigger: SummaryTriggerState = {
		lastAttemptAt: null,
		summarizedUserTurnAt: null,
		latestUserTurnAt: null,
		turns: 0,
	};
	/** Isolated provider session for summary requests, minted per conversation. */
	#providerSessionId: string | null = null;
	#inflight: AbortController | null = null;
	/** A turn settled while a generation was running; re-evaluate once it ends. */
	#dirty = false;
	#retryTimer: NodeJS.Timeout | undefined;
	#detachSession: (() => void) | null = null;
	readonly #listeners = new Set<SummaryListener>();
	/** Background loads and generations still running, including cancelled ones. */
	readonly #pending = new Set<Promise<void>>();

	constructor(options: MeshSummaryGeneratorOptions = {}) {
		this.#minIntervalMs = options.minIntervalMs ?? SUMMARY_MIN_INTERVAL_MS;
		this.#minTurns = options.minTurns ?? SUMMARY_MIN_TURNS;
	}

	/** Latest summary for the attached session; `null` when disabled or none yet. */
	get current(): MeshSummaryState | null {
		const session = this.#session;
		if (!session || !this.#enabled(session)) return null;
		return this.#summary;
	}

	/** Called with {@link current} whenever it changes, including on enable/disable. */
	onChange(listener: SummaryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Resolves once every background load and generation (including cancelled ones) has finished. */
	async settled(): Promise<void> {
		while (this.#pending.size > 0) await Promise.all(this.#pending);
	}

	#track(work: Promise<void>): void {
		this.#pending.add(work);
		void work.finally(() => this.#pending.delete(work));
	}

	/** Track `session` (replacing any previous one); the returned disposer detaches it. */
	attach(session: AgentSession): () => void {
		this.#detach();
		this.#session = session;
		const onGateChange = () => {
			this.#emit();
			if (!session.isStreaming) this.#evaluate(session);
		};
		const disposers = [
			session.subscribe(event => {
				if (event.type === "agent_end" && event.isTerminal !== false) this.#onTurnSettled();
			}),
			session.registerSessionChangeCallback(() => this.#reset()),
			cfgMeshEnabled.listen(session.settings, onGateChange),
			cfgMeshSummary.listen(session.settings, onGateChange),
		];
		const detach = () => {
			for (const dispose of disposers) dispose();
		};
		this.#detachSession = detach;
		this.#reset();
		return () => {
			if (this.#detachSession === detach) this.#detach();
		};
	}

	#detach(): void {
		this.#detachSession?.();
		this.#detachSession = null;
		this.#cancelPending();
		const hadSummary = this.current !== null;
		this.#session = null;
		this.#sessionId = null;
		this.#summary = null;
		if (hadSummary) this.#emit();
	}

	#enabled(session: AgentSession): boolean {
		return cfgMeshEnabled.get(session.settings) && cfgMeshSummary.get(session.settings);
	}

	/** Forget the previous conversation's summary and load the current one's from disk. */
	#reset(): void {
		const session = this.#session;
		if (!session) return;
		this.#cancelPending();
		this.#sessionId = session.sessionManager.getSessionId();
		this.#providerSessionId = null;
		this.#trigger = { lastAttemptAt: null, summarizedUserTurnAt: null, latestUserTurnAt: null, turns: 0 };
		this.#setSummary(null);
		this.#track(this.#load(session, this.#sessionId));
	}

	#cancelPending(): void {
		this.#inflight?.abort();
		this.#inflight = null;
		this.#dirty = false;
		clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
	}

	#setSummary(summary: MeshSummaryState | null): void {
		if (this.#summary === summary) return;
		this.#summary = summary;
		this.#emit();
	}

	#emit(): void {
		const current = this.current;
		for (const listener of this.#listeners) {
			try {
				listener(current);
			} catch (error) {
				logger.debug("mesh summary: listener failed", { error: String(error) });
			}
		}
	}

	#isCurrent(session: AgentSession, sessionId: string): boolean {
		return this.#session === session && this.#sessionId === sessionId;
	}

	async #load(session: AgentSession, sessionId: string): Promise<void> {
		const file = summaryPath(session);
		if (!file) return;
		let raw: unknown;
		try {
			raw = await Bun.file(file).json();
		} catch (error) {
			if (!isEnoent(error)) logger.debug("mesh summary: failed to read persisted summary", { error: String(error) });
			return;
		}
		const persisted = parsePersisted(raw);
		// A summary generated meanwhile is newer than anything on disk.
		if (!persisted || persisted.sessionId !== sessionId || !this.#isCurrent(session, sessionId) || this.#summary) {
			return;
		}
		this.#trigger = {
			...this.#trigger,
			lastAttemptAt: persisted.updatedAt,
			summarizedUserTurnAt: persisted.userTurnAt,
		};
		this.#setSummary({ text: persisted.text, updatedAt: persisted.updatedAt });
	}

	#onTurnSettled(): void {
		const session = this.#session;
		if (!session) return;
		// The change callback normally resets first; this covers any id adopted without one.
		if (session.sessionManager.getSessionId() !== this.#sessionId) this.#reset();
		this.#evaluate(session);
	}

	#evaluate(session: AgentSession): void {
		if (this.#session !== session || !this.#enabled(session) || session.isDisposed) return;
		if (this.#inflight) {
			this.#dirty = true;
			return;
		}
		this.#trigger.latestUserTurnAt = latestOperatorTurnAt(session.messages);
		this.#trigger.turns = completedModelTurns(session.messages, this.#minTurns);
		const now = Date.now();
		if (shouldRegenerateSummary(this.#trigger, now, this.#minIntervalMs, this.#minTurns)) {
			this.#track(this.#generate(session, now));
			return;
		}
		const { lastAttemptAt, latestUserTurnAt, summarizedUserTurnAt, turns } = this.#trigger;
		const pendingTurn =
			latestUserTurnAt !== null && (summarizedUserTurnAt === null || latestUserTurnAt > summarizedUserTurnAt);
		// Waiting for model turns is not waiting for the interval: only a settled turn adds one, and
		// its own `agent_end` re-evaluates. A timer here could fire with a past deadline, in a loop.
		const awaitingTurns = summarizedUserTurnAt === null && turns < this.#minTurns;
		if (!pendingTurn || awaitingTurns || lastAttemptAt === null || this.#retryTimer) return;
		// Cover the last turns of a burst that ends inside the interval.
		this.#retryTimer = setTimeout(
			() => {
				this.#retryTimer = undefined;
				// A running turn re-evaluates on its own `agent_end`.
				if (!session.isStreaming) this.#evaluate(session);
			},
			lastAttemptAt + this.#minIntervalMs - now,
		);
		this.#retryTimer.unref();
	}

	async #generate(session: AgentSession, now: number): Promise<void> {
		const sessionId = this.#sessionId;
		if (!sessionId) return;
		const coveredTurnAt = this.#trigger.latestUserTurnAt;
		this.#trigger.lastAttemptAt = now;
		const controller = new AbortController();
		this.#inflight = controller;
		try {
			// A capped session sends no further model requests.
			if (session.costGate.check()) return;
			const rawInput = buildSummaryInput(session);
			if (!rawInput) return;
			// Like the main conversation, configured secrets reach the provider only as placeholders.
			// The reply stays obfuscated: peers must never see the real values.
			const input = session.obfuscator?.obfuscate(rawInput) ?? rawInput;
			const settings = session.settings;
			const registry = session.modelRegistry;
			const models = selectBackgroundModels(registry, settings, {
				pool: "smol",
				roles: ["smol"],
				currentModel: session.model,
			});
			if (models.length === 0) {
				logger.debug("mesh summary: no smol model available");
				return;
			}
			this.#providerSessionId ??= Bun.randomUUIDv7();
			const providerSessionId = this.#providerSessionId;
			const text = await withCredentialRedaction(cfgSecretsEnabled.get(settings), () =>
				completeWithBackgroundModels({
					models,
					registry,
					systemPrompt: [SUMMARY_SYSTEM_PROMPT],
					buildMessages: () => [{ role: "user", content: input, timestamp: Date.now() }],
					parse: parseSummaryResponse,
					maxTokens: SUMMARY_MAX_TOKENS,
					sessionId: providerSessionId,
					credentialSourceSessionId: session.sessionId,
					metadataResolver: provider => buildSessionMetadata(providerSessionId, provider, registry.authStorage),
					signal: controller.signal,
					onResponse: response => session.costGate.record(response.usage.cost.total),
					log: {
						prefix: "mesh-summary",
						context: { summarySessionId: providerSessionId },
						resultLabel: "summary",
					},
				}),
			);
			if (!text || controller.signal.aborted || !this.#isCurrent(session, sessionId)) return;
			const summary = { text, updatedAt: Date.now() };
			this.#trigger.summarizedUserTurnAt = coveredTurnAt;
			this.#setSummary(summary);
			await persistSummary(session, { v: 1, sessionId, ...summary, userTurnAt: coveredTurnAt });
		} catch (error) {
			logger.debug("mesh summary: generation failed", { error: String(error) });
		} finally {
			if (this.#inflight === controller) {
				this.#inflight = null;
				// Turns that settled meanwhile were deferred; a failed attempt only arms the interval timer.
				if (this.#dirty && this.#isCurrent(session, sessionId) && !session.isStreaming) {
					this.#dirty = false;
					this.#evaluate(session);
				}
			}
		}
	}
}

function summaryPath(session: AgentSession): string | null {
	const dir = session.sessionManager.getArtifactsDir();
	return dir ? path.join(dir, SUMMARY_FILE) : null;
}

async function persistSummary(session: AgentSession, record: PersistedSummary): Promise<void> {
	const file = summaryPath(session);
	if (!file) return;
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await writeFileAtomically(file, JSON.stringify(record));
	} catch (error) {
		logger.debug("mesh summary: failed to persist summary", { error: String(error) });
	}
}

function parsePersisted(raw: unknown): PersistedSummary | null {
	if (!isRecord(raw) || raw.v !== 1) return null;
	const { sessionId, text, updatedAt, userTurnAt } = raw;
	if (typeof sessionId !== "string" || typeof text !== "string" || typeof updatedAt !== "number") return null;
	if (userTurnAt !== null && typeof userTurnAt !== "number") return null;
	const clean = sanitizeSummary(text);
	return clean ? { v: 1, sessionId, text: clean, updatedAt, userTurnAt } : null;
}

/** Timestamp of the newest message the operator wrote (typed prompt or `/skill:` chip). */
function latestOperatorTurnAt(messages: readonly AgentMessage[]): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (operatorTitleText(message) !== undefined) return message.timestamp;
	}
	return null;
}

/** Assistant replies that completed (not aborted or failed), counted up to `limit`: only reaching it matters. */
function completedModelTurns(messages: readonly AgentMessage[], limit: number): number {
	let turns = 0;
	for (const message of messages) {
		if (turns >= limit) break;
		if (message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error") turns++;
	}
	return turns;
}

/** Render the summary request, or `null` when the operator has not asked anything yet. */
function buildSummaryInput(session: AgentSession): string | null {
	const messages = session.messages;
	const requests: string[] = [];
	let assistant = "";
	for (let i = messages.length - 1; i >= 0 && requests.length < MAX_REQUESTS; i--) {
		const message = messages[i];
		if (
			!assistant &&
			message.role === "assistant" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			const text = message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
			assistant = truncate(cleanTinyMessage(text).trim(), MAX_ASSISTANT_CHARS);
			continue;
		}
		const operatorText = operatorTitleText(message);
		const request = operatorText ? truncate(cleanTinyMessage(operatorText).trim(), MAX_REQUEST_CHARS) : "";
		if (request) requests.push(request);
	}
	if (requests.length === 0) return null;
	requests.reverse();

	const phases: { name: string; tasks: { status: string; content: string }[] }[] = [];
	let taskBudget = MAX_TODO_TASKS;
	for (const phase of session.getTodoPhases()) {
		if (taskBudget <= 0) break;
		const tasks = phase.tasks.slice(0, taskBudget).map(task => ({
			status: task.status,
			content: truncate(task.content, MAX_NAME_CHARS),
		}));
		taskBudget -= tasks.length;
		phases.push({ name: truncate(phase.name, MAX_NAME_CHARS), tasks });
	}

	return prompt.render(meshSummaryUserTemplate, {
		sessionName: truncate(session.sessionManager.getSessionName() ?? "", MAX_NAME_CHARS),
		cwd: session.sessionManager.getCwd(),
		phases,
		requests,
		assistant,
	});
}

function parseSummaryResponse(response: AssistantMessage): string | undefined {
	// A reply cut at the token cap may end mid-thought; never publish a fragment.
	if (response.stopReason === "length") return undefined;
	return sanitizeSummary(response.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n"));
}

/** Plain text from a model reply: no controls, thinking, tags or markdown; bounded to {@link MAX_SUMMARY_CHARS}. */
function sanitizeSummary(raw: string): string | undefined {
	const text = sanitizeText(stripLeakedThinkingMarkup(raw))
		.replace(ORPHAN_THINKING_CLOSE_RE, " ")
		.replace(TAG_RE, " ")
		.replace(LINE_MARKER_RE, "")
		.replace(EMPHASIS_RE, "")
		.replace(/\s+/g, " ")
		.trim();
	return text ? truncate(text, MAX_SUMMARY_CHARS).toWellFormed() : undefined;
}
