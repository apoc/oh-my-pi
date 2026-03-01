import type { Api, Model } from "@oh-my-pi/pi-ai";

import type { ModelRegistry } from "../config/model-registry";
import { parseModelString } from "../config/model-resolver";
import MODEL_PRIO from "../priority.json" with { type: "json" };

export function getSmolModelCandidates(registry: ModelRegistry, savedSmolModel?: string): Model<Api>[] {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return [];

	const candidates: Model<Api>[] = [];
	const addCandidate = (model?: Model<Api>): void => {
		if (!model) return;
		if (candidates.some(c => c.provider === model.provider && c.id === model.id)) return;
		candidates.push(model);
	};

	if (savedSmolModel) {
		const parsed = parseModelString(savedSmolModel);
		if (parsed) {
			const match = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			addCandidate(match);
		}
	}

	for (const pattern of MODEL_PRIO.smol) {
		const needle = pattern.toLowerCase();
		addCandidate(availableModels.find(m => m.id.toLowerCase() === needle));
		addCandidate(availableModels.find(m => m.id.toLowerCase().includes(needle)));
	}

	for (const model of availableModels) {
		addCandidate(model);
	}

	return candidates;
}
