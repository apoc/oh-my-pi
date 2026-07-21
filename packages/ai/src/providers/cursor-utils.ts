import type { AssistantMessage } from "../types";

/**
 * Apply Cursor's cumulative conversation-token counter (`tokenDetails.usedTokens`)
 * to a streaming assistant message. The counter is monotonically increasing across
 * a multi-turn conversation, so it is anchored on `usage.totalTokens` (which
 * {@link calculateContextTokens} and {@link calculatePromptTokens} both prefer
 * when set). The per-turn `usage.input` / `usage.cacheRead` fields are left at 0
 * so session aggregators that sum across assistant messages
 * (footer/getSessionStats) do not double-count cumulative context across turns.
 */
export function applyCursorConversationTokenDetails(output: AssistantMessage, usedTokens: number): void {
	output.usage.totalTokens = Math.max(output.usage.totalTokens, usedTokens);
}

/**
 * Apply a per-turn output-token delta and ratchet `totalTokens` so the cumulative
 * anchor written by a prior checkpoint is preserved across subsequent deltas.
 */
export function applyCursorTokenDelta(output: AssistantMessage, deltaTokens: number): void {
	output.usage.output += deltaTokens;
	applyCursorConversationTokenDetails(output, output.usage.input + output.usage.output);
}

/**
 * Cursor reports a single cumulative `totalTokens` per conversation that already
 * includes prior turns; its per-message input/output/cache splits do not sum to
 * it. Synthesize phantom input tokens to cover the gap between Cursor's cumulative
 * counter and the tokens summed from `cursor-agent` messages **only**.
 *
 * `cursorSummedTokens` is the sum of input+output+cacheRead+cacheWrite over the
 * Cursor-agent assistant messages — not the global total. Anchoring the phantom on
 * the Cursor-only sum keeps the aggregate reconciled for display without folding
 * Cursor's cumulative counter onto unrelated non-Cursor usage in a mixed-provider
 * session (which previously inflated the displayed input token count).
 */
export function reconcileCursorCumulativeTokens(totals: {
	totalInput: number;
	cursorSummedTokens: number;
	latestCursorTotalTokens: number;
}): { totalInput: number } {
	const cursorPhantom = Math.max(0, totals.latestCursorTotalTokens - totals.cursorSummedTokens);
	return { totalInput: totals.totalInput + cursorPhantom };
}
