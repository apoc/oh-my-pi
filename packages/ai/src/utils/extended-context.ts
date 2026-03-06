import type { Model } from "../types";

/** Whether a model supports an extended context window. */
export function supportsExtendedContext(model: Model): boolean {
	return model.maxContextWindow != null;
}

/** Whether the given context budget requires extended context activation. */
export function needsExtendedContext(model: Model, contextBudget: number): boolean {
	return model.maxContextWindow != null && contextBudget > model.contextWindow;
}

/** Beta header required to unlock 1M context window on Anthropic API. */
export const CONTEXT_1M_BETA = "context-1m-2025-08-07";

// ============================================================
// Extended context entitlement (Anthropic overage header)
// ============================================================
//
// Anthropic's API piggybacks an `anthropic-ratelimit-unified-overage-disabled-reason`
// header on every response. For OAuth/subscription users this gates whether 1M
// context is available. API key users are always allowed (the API enforces limits).
//
// The cached value is `undefined` (never checked), `null` (allowed), or a reason string.

/** Response header that carries the overage-disabled reason. */
export const OVERAGE_DISABLED_HEADER = "anthropic-ratelimit-unified-overage-disabled-reason";

// Known blocking reasons (for reference — kept as documentation, not code):
// overage_not_provisioned, org_level_disabled, org_level_disabled_until,
// seat_tier_level_disabled, member_level_disabled, seat_tier_zero_credit_limit,
// group_zero_credit_limit, member_zero_credit_limit, org_service_level_disabled,
// org_service_zero_credit_limit, no_limits_configured, unknown
//
// The access check is fail-closed: only explicitly allowed reasons pass.

/**
 * Cached overage-disabled reason: `undefined` = never checked, `null` = allowed, string = reason.
 *
 * WARNING: Process-global mutable state. If multiple sessions with different OAuth
 * tokens ever run in the same process, they will share this cache.
 */
let cachedOverageReason: string | null | undefined;

/**
 * Update the cached overage-disabled reason from API response headers.
 * Only updates when the header is actually present — a response without the header
 * does not clear a previously cached blocking reason.
 * Call this from the `onResponseHeaders` callback for Anthropic providers.
 */
export function updateOverageDisabledReason(headers: Record<string, string>): void {
	if (OVERAGE_DISABLED_HEADER in headers) {
		// Use || null so an empty-string value is treated as "no restriction"
		cachedOverageReason = headers[OVERAGE_DISABLED_HEADER] || null;
	}
}

/**
 * Whether the current user has access to extended context based on the
 * overage-disabled reason cached from Anthropic response headers.
 *
 * - `undefined` (never checked): allow — the API enforces on the next call,
 *   and we revoke if a blocking reason appears in the response headers.
 * - `null` (no restriction): allowed
 * - `"out_of_credits"`: still allowed (mirrors Claude Code behavior)
 * - Any other known blocking reason: disallowed
 * - Any unknown reason string: disallowed (fail-closed)
 */
export function hasExtendedContextAccess(isOAuth: boolean): boolean {
	// API key users are always allowed — the API enforces limits directly
	if (!isOAuth) return true;
	// OAuth user: check cached reason (API is the real enforcement layer)
	if (cachedOverageReason === undefined) return true; // not checked yet — allow, API will enforce
	if (cachedOverageReason === null) return true; // no restriction
	if (cachedOverageReason === "out_of_credits") return true; // still allowed
	return false; // unknown reason — fail-closed
}

/** Reset cached state (for testing). */
export function resetOverageCache(): void {
	cachedOverageReason = undefined;
}

/**
 * Clamp a requested context budget to the model's valid range [contextWindow, maxContextWindow].
 * Returns the clamped value. If the model has no maxContextWindow, the budget is clamped to contextWindow.
 */
export function clampContextBudget(budget: number, model: Model): number {
	const max = model.maxContextWindow ?? model.contextWindow;
	return Math.max(model.contextWindow, Math.min(max, budget));
}
