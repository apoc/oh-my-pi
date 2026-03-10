import { describe, expect, test } from "bun:test";
import { type Api, getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolvePrimaryModel } from "../src/commit/model-selection";

describe("resolvePrimaryModel", () => {
	test("prefers default role over compaction when commit and smol are unset", async () => {
		const defaultModel = getBundledModel("openai", "gpt-4o");
		const compactionModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected bundled model openai/gpt-4o");
		if (!compactionModel) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				compaction: `${compactionModel.provider}/${compactionModel.id}`,
			},
		});
		const availableModels = [compactionModel, defaultModel];
		const modelRegistry = {
			getAvailable: () => availableModels,
			getApiKey: async (model: Model<Api>) =>
				model.provider === defaultModel.provider && model.id === defaultModel.id ? "default-key" : "compaction-key",
		};

		const result = await resolvePrimaryModel(undefined, settings, modelRegistry);

		expect(result.model.provider).toBe(defaultModel.provider);
		expect(result.model.id).toBe(defaultModel.id);
		expect(result.apiKey).toBe("default-key");
	});
});
