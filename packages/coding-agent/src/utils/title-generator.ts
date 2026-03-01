/**
 * Generate session titles using a smol, fast model.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { renderPromptTemplate } from "../config/prompt-templates";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { getSmolModelCandidates } from "./model-candidates";

const TITLE_SYSTEM_PROMPT = renderPromptTemplate(titleSystemPrompt);

const MAX_INPUT_CHARS = 2000;

/**
 * Generate a title for a session based on the first user message.
 *
 * @param firstMessage The first user message
 * @param registry Model registry
 * @param savedSmolModel Optional saved smol model from settings (provider/modelId format)
 * @param sessionId Optional session id for sticky API key selection
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	savedSmolModel?: string,
	sessionId?: string,
): Promise<string | null> {
	const candidates = getSmolModelCandidates(registry, savedSmolModel);
	if (candidates.length === 0) {
		logger.debug("title-generator: no smol model found");
		return null;
	}

	// Truncate message if too long
	const truncatedMessage =
		firstMessage.length > MAX_INPUT_CHARS ? `${firstMessage.slice(0, MAX_INPUT_CHARS)}…` : firstMessage;
	const userMessage = `<user-message>\n${truncatedMessage}\n</user-message>`;

	for (const model of candidates) {
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) {
			logger.debug("title-generator: no API key for model", { provider: model.provider, id: model.id });
			continue;
		}

		const request = {
			model: `${model.provider}/${model.id}`,
			systemPrompt: TITLE_SYSTEM_PROMPT,
			userMessage,
			maxTokens: 30,
		};
		logger.debug("title-generator: request", request);

		try {
			const response = await completeSimple(
				model,
				{
					systemPrompt: request.systemPrompt,
					messages: [{ role: "user", content: request.userMessage, timestamp: Date.now() }],
				},
				{
					apiKey,
					maxTokens: 30,
				},
			);

			if (response.stopReason === "error") {
				logger.debug("title-generator: response error", {
					model: request.model,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				});
				continue;
			}

			// Extract title from response text content
			let title = "";
			for (const content of response.content) {
				if (content.type === "text") {
					title += content.text;
				}
			}
			title = title.trim();

			logger.debug("title-generator: response", {
				model: request.model,
				title,
				usage: response.usage,
				stopReason: response.stopReason,
			});

			if (!title) {
				continue;
			}

			// Clean up: remove quotes, trailing punctuation
			return title.replace(/^["']|["']$/g, "").replace(/[.!?]$/, "");
		} catch (err) {
			logger.debug("title-generator: error", {
				model: request.model,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return null;
}

/**
 * Set the terminal title using ANSI escape sequences.
 */
export function setTerminalTitle(title: string): void {
	// OSC 2 sets the window title
	process.stdout.write(`\x1b]2;${title}\x07`);
}
