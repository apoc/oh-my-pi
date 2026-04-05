/**
 * Tool output pruning utilities for compaction.
 *
 * Pruning is DESTRUCTIVE: it replaces tool-result content in the persistent
 * session history with a short notice. Unlike ephemeral thinning (see
 * context-thinning.ts) the mutation lands in the session file and is visible
 * to the user on reload.
 *
 * Eligibility is a denylist, not an allowlist: by default every tool result
 * is prunable once it falls out of the recent-tokens protection window. Only
 * tools whose raw content the user must retain to understand the session
 * are added to the protected set. This keeps `task` subagent outputs,
 * `generate_image` blobs, and all MCP / extension tool results prunable,
 * because those are the largest space offenders in heavy sessions.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "../session-manager";
import { estimateTokens } from "./compaction";

export interface PruneConfig {
	/**
	 * Fraction of the context window to protect from pruning (0–1).
	 * The most recent tool outputs totalling this share of the window are kept intact.
	 */
	protectFraction: number;
	/** Skip pruning unless estimated savings exceed this token count. */
	minimumSavings: number;
	/**
	 * Denylist of tool names NEVER subject to pruning, regardless of age.
	 * Every other tool — including unknown MCP / extension tools and subagent
	 * `task` results — is eligible once outside the protection window.
	 */
	protectedTools: string[];
}

/**
 * Tools whose raw content must remain in the persistent session history.
 * - `read`: users rely on scrolling back to see what the model read from their
 *   files. A pruned `read` hides the file contents that drove subsequent edits
 *   and breaks checkpoint/rewind semantics.
 */
const PRUNE_PROTECTED_TOOLS: readonly string[] = ["read"];

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	// 20% of context window — protects the last ~1–2 heavy turns regardless of model size.
	protectFraction: 0.2,
	minimumSavings: 5_000,
	protectedTools: [...PRUNE_PROTECTED_TOOLS],
};

// Cap prevents runaway budget on large-context models (1M+).
// Without this, 20% of 1M = 200K protected — larger than the 80K cap itself.
const MAX_PROTECT_TOKENS = 80_000;

/**
 * Conservative fallback context window for models whose metadata is unavailable.
 * 200K matches the minimum context size across current Anthropic, OpenAI, and Google
 * frontier models. Callers pass `model?.contextWindow ?? 0` and let
 * `resolveProtectTokens` substitute this fallback rather than producing a zero
 * protection budget.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export function resolveProtectTokens(config: PruneConfig, contextWindow: number): number {
	// Treat 0/negative as "unknown" and fall back to the default. Without this
	// guard, an unknown context window would produce a 0-token protection budget
	// and aggressively prune the most recent tool results — the wrong failure mode.
	const effective = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
	return Math.min(MAX_PROTECT_TOKENS, Math.floor(effective * config.protectFraction));
}

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
}

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number): number {
	const noticeTokens = Math.ceil(createPrunedNotice(tokens).length / 4);
	return Math.max(0, tokens - noticeTokens);
}

export function pruneToolOutputs(
	entries: SessionEntry[],
	contextWindow: number,
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): PruneResult {
	// Compute once — the protection budget does not change across entries.
	const protectTokens = resolveProtectTokens(config, contextWindow);
	const protectedSet = new Set(config.protectedTools);

	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number }> = [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateTokens(message as AgentMessage);
		// Denylist: prune anything not explicitly protected. Unknown MCP /
		// extension tools are prunable by default so large sessions can recover.
		const isEligible = !protectedSet.has(message.toolName);

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		if (accumulatedTokens < protectTokens || !isEligible) {
			accumulatedTokens += tokens;
			continue;
		}

		candidates.push({ entry: entry as SessionMessageEntry, tokens });
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(candidate.tokens);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0 };
	}

	const prunedAt = Date.now();
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		message.content = [{ type: "text", text: createPrunedNotice(candidate.tokens) }];
		message.prunedAt = prunedAt;
		prunedCount++;
	}

	return { prunedCount, tokensSaved };
}
