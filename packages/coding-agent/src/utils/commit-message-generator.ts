/**
 * Generate commit messages from diffs using a smol, fast model.
 * Follows the same pattern as title-generator.ts.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { renderPromptTemplate } from "../config/prompt-templates";
import commitSystemPrompt from "../prompts/system/commit-message-system.md" with { type: "text" };
import { getSmolModelCandidates } from "./model-candidates";

const COMMIT_SYSTEM_PROMPT = renderPromptTemplate(commitSystemPrompt);
const MAX_DIFF_CHARS = 4000;

/** File patterns that should be excluded from commit message generation diffs. */
const NOISE_SUFFIXES = [".lock", ".lockb", "-lock.json", "-lock.yaml"];

/** Strip diff hunks for noisy files that drown out real changes. */
function filterDiffNoise(diff: string): string {
	const lines = diff.split("\n");
	const filtered: string[] = [];
	let skip = false;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			const bPath = line.split(" b/")[1];
			skip = bPath != null && NOISE_SUFFIXES.some(s => bPath.endsWith(s));
		}
		if (!skip) filtered.push(line);
	}
	return filtered.join("\n");
}

/**
 * Generate a commit message from a unified diff.
 * Returns null if generation fails (caller should fall back to generic message).
 */
export async function generateCommitMessage(
	diff: string,
	registry: ModelRegistry,
	savedSmolModel?: string,
	sessionId?: string,
): Promise<string | null> {
	const candidates = getSmolModelCandidates(registry, savedSmolModel);
	if (candidates.length === 0) {
		logger.debug("commit-msg-generator: no smol model found");
		return null;
	}

	const cleanDiff = filterDiffNoise(diff);
	const truncatedDiff =
		cleanDiff.length > MAX_DIFF_CHARS ? `${cleanDiff.slice(0, MAX_DIFF_CHARS)}\n… (truncated)` : cleanDiff;
	if (!truncatedDiff.trim()) {
		logger.debug("commit-msg-generator: diff is empty after noise filtering");
		return null;
	}
	const userMessage = `<diff>\n${truncatedDiff}\n</diff>`;

	for (const model of candidates) {
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) continue;

		try {
			const response = await completeSimple(
				model,
				{
					systemPrompt: COMMIT_SYSTEM_PROMPT,
					messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
				},
				{ apiKey, maxTokens: 60 },
			);

			if (response.stopReason === "error") {
				logger.debug("commit-msg-generator: error", { model: model.id, error: response.errorMessage });
				continue;
			}

			let msg = "";
			for (const content of response.content) {
				if (content.type === "text") msg += content.text;
			}
			msg = msg.trim();
			if (!msg) continue;

			// Clean up: remove wrapping quotes, backticks, trailing period
			msg = msg.replace(/^[`"']|[`"']$/g, "").replace(/\.$/, "");

			logger.debug("commit-msg-generator: generated", { model: model.id, msg });
			return msg;
		} catch (err) {
			logger.debug("commit-msg-generator: error", {
				model: model.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return null;
}
