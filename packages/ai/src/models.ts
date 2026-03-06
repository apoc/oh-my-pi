import { enrichModelThinking } from "./model-thinking";
import MODELS from "./models.json" with { type: "json" };
import type { Api, KnownProvider, Model, Usage } from "./types";

/**
 * Static bundled model registry loaded from `models.json`.
 *
 * This module intentionally exposes compile-time defaults only.
 * It does not include runtime discovery, models.dev overlays, or on-disk cache state.
 *
 * For runtime-aware resolution, use `createModelManager()` / `resolveProviderModels()`.
 */
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, enrichModelThinking(model as Model<Api>));
	}
	modelRegistry.set(provider, providerModels);
}

export type GeneratedProvider = keyof typeof MODELS;

export function getBundledModel(provider: GeneratedProvider, modelId: string): Model<Api> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId) as Model<Api>;
}

export function getBundledProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	let { input: inputRate, output: outputRate, cacheRead: cacheReadRate, cacheWrite: cacheWriteRate } = model.cost;

	// Apply premium long-context rates when total input exceeds the model's threshold.
	if (model.longContextPricing) {
		const totalInput = usage.input + usage.cacheRead + usage.cacheWrite; // per Anthropic docs: threshold = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
		if (totalInput > model.longContextPricing.inputThreshold) {
			const lc = model.longContextPricing;
			inputRate = lc.input;
			outputRate = lc.output;
			if (lc.cacheRead != null) cacheReadRate = lc.cacheRead;
			if (lc.cacheWrite != null) cacheWriteRate = lc.cacheWrite;
		}
	}

	usage.cost.input = (inputRate / 1_000_000) * usage.input;
	usage.cost.output = (outputRate / 1_000_000) * usage.output;
	usage.cost.cacheRead = (cacheReadRate / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = (cacheWriteRate / 1_000_000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}
/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
