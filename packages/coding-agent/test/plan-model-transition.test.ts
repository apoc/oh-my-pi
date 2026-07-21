import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ResolvedModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resolvePlanModelTransition } from "@oh-my-pi/pi-coding-agent/plan-mode/model-transition";

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	});
}

function makeCursorModel(id: string): Model<"cursor-agent"> {
	return buildModel({
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 64_000,
		extendedContext: {
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			baseContextWindow: 272_000,
			baseMaxTokens: 64_000,
		},
	});
}

function resolved(
	model: Model,
	options: { thinkingLevel?: ThinkingLevel; maxMode?: boolean } = {},
): ResolvedModelRoleValue {
	return {
		model,
		thinkingLevel: options.thinkingLevel,
		explicitThinkingLevel: options.thinkingLevel !== undefined,
		maxMode: options.maxMode,
		warning: undefined,
	};
}

describe("resolvePlanModelTransition", () => {
	it("reconciles MAX on the same Cursor model without a provider-session reset", () => {
		const model = makeCursorModel("gpt-5.5-extra-high");

		expect(resolvePlanModelTransition(model, resolved(model, { maxMode: true }), false)).toEqual({
			kind: "flags",
			model,
			thinkingLevel: undefined,
			maxMode: true,
		});
		expect(resolvePlanModelTransition(model, resolved(model), false)).toEqual({
			kind: "flags",
			model,
			thinkingLevel: undefined,
			maxMode: false,
		});
	});

	it("carries MAX when switching or deferring a Cursor plan model", () => {
		const current = makeModel("openai", "gpt-5.5");
		const plan = makeCursorModel("gpt-5.5-extra-high");

		expect(resolvePlanModelTransition(current, resolved(plan, { maxMode: true }), true)).toEqual({
			kind: "apply",
			model: plan,
			thinkingLevel: undefined,
			maxMode: true,
			deferred: true,
		});
	});

	it("keeps same-model thinking transitions alongside selector flags", () => {
		const model = makeModel("openai", "gpt-5.5");

		expect(resolvePlanModelTransition(model, resolved(model, { thinkingLevel: ThinkingLevel.High }), false)).toEqual({
			kind: "flags",
			model,
			thinkingLevel: ThinkingLevel.High,
			maxMode: undefined,
		});
	});
});
