import { describe, expect, it } from "bun:test";
import type { Model } from "../src/types";
import {
	hasExtendedContextAccess,
	needsExtendedContext,
	resetOverageCache,
	supportsExtendedContext,
	updateOverageDisabledReason,
} from "../src/utils/extended-context";

function makeModel(overrides: Partial<Model> = {}): Model {
	return {
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		...overrides,
	};
}

describe("supportsExtendedContext", () => {
	it("returns true when maxContextWindow is set", () => {
		const model = makeModel({ maxContextWindow: 1_000_000 });
		expect(supportsExtendedContext(model)).toBe(true);
	});

	it("returns false when maxContextWindow is undefined", () => {
		const model = makeModel();
		expect(supportsExtendedContext(model)).toBe(false);
	});

	it("returns false when maxContextWindow is null", () => {
		const model = makeModel({ maxContextWindow: null as unknown as undefined });
		expect(supportsExtendedContext(model)).toBe(false);
	});
});

describe("needsExtendedContext", () => {
	it("returns true when budget exceeds baseline and model has maxContextWindow", () => {
		const model = makeModel({ maxContextWindow: 1_000_000 });
		expect(needsExtendedContext(model, 500_000)).toBe(true);
	});

	it("returns false when budget equals baseline", () => {
		const model = makeModel({ maxContextWindow: 1_000_000 });
		expect(needsExtendedContext(model, 200_000)).toBe(false);
	});

	it("returns false when budget is below baseline", () => {
		const model = makeModel({ maxContextWindow: 1_000_000 });
		expect(needsExtendedContext(model, 100_000)).toBe(false);
	});

	it("returns false when model has no maxContextWindow", () => {
		const model = makeModel();
		expect(needsExtendedContext(model, 500_000)).toBe(false);
	});

	it("returns true at budget just above baseline", () => {
		const model = makeModel({ maxContextWindow: 1_000_000 });
		expect(needsExtendedContext(model, 200_001)).toBe(true);
	});
});

describe("hasExtendedContextAccess", () => {
	// Reset cache between tests
	it("API key users always have access", () => {
		resetOverageCache();
		expect(hasExtendedContextAccess(false)).toBe(true);
	});

	it("OAuth users allowed before first API call (cache undefined, API enforces)", () => {
		resetOverageCache();
		expect(hasExtendedContextAccess(true)).toBe(true);
	});

	it("OAuth users allowed when no restriction (header present, no value)", () => {
		resetOverageCache();
		updateOverageDisabledReason({ "anthropic-ratelimit-unified-overage-disabled-reason": "" });
		expect(hasExtendedContextAccess(true)).toBe(true);
	});

	it("absent overage header does not clear a previously cached blocking reason", () => {
		resetOverageCache();
		updateOverageDisabledReason({ "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled" });
		// Subsequent response without the header must not clear the cached reason
		updateOverageDisabledReason({});
		expect(hasExtendedContextAccess(true)).toBe(false);
	});

	it("OAuth users allowed when out_of_credits", () => {
		resetOverageCache();
		updateOverageDisabledReason({ "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits" });
		expect(hasExtendedContextAccess(true)).toBe(true);
	});

	it("OAuth users denied for blocking reasons", () => {
		const blockingReasons = [
			"overage_not_provisioned",
			"org_level_disabled",
			"seat_tier_level_disabled",
			"member_level_disabled",
			"no_limits_configured",
			"unknown",
		];
		for (const reason of blockingReasons) {
			resetOverageCache();
			updateOverageDisabledReason({ "anthropic-ratelimit-unified-overage-disabled-reason": reason });
			expect(hasExtendedContextAccess(true)).toBe(false);
		}
	});

	it("API key users unaffected by blocking reasons", () => {
		resetOverageCache();
		updateOverageDisabledReason({ "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled" });
		expect(hasExtendedContextAccess(false)).toBe(true);
	});

	it("OAuth users denied for unknown future reason strings (fail-closed)", () => {
		resetOverageCache();
		updateOverageDisabledReason({ "anthropic-ratelimit-unified-overage-disabled-reason": "some_future_reason" });
		expect(hasExtendedContextAccess(true)).toBe(false);
	});
});
