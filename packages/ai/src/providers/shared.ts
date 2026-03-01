import type {
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputMessage,
} from "openai/resources/responses/responses";
import type { Api, AssistantMessage, Context, ImageContent, Model, TextContent, ToolCall } from "../types";
import { normalizeResponsesToolCallId, normalizeToolCallId } from "../utils";
import { transformMessages } from "./transform-messages";

export function createErrorMessage(model: Model<Api>, err: unknown) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error" as const,
		timestamp: Date.now(),
	};
}

/**
 * Shared convertMessages for OpenAI Responses API providers.
 * Used by both openai-responses and azure-openai-responses.
 */
export function convertResponsesMessages(
	model: Model<Api>,
	context: Context,
	strictResponsesPairing: boolean,
): ResponseInput {
	const messages: ResponseInput = [];
	const knownCallIds = new Set<string>();

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	if (context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system";
		messages.push({
			role,
			content: context.systemPrompt.toWellFormed(),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			if (typeof msg.content === "string") {
				// Skip empty user messages
				if (!msg.content || msg.content.trim() === "") continue;
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: msg.content.toWellFormed() }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: item.text.toWellFormed(),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				// Filter out images if model doesn't support them, and empty text blocks
				let filteredContent = !model.input.includes("image")
					? content.filter(c => c.type !== "input_image")
					: content;
				filteredContent = filteredContent.filter(c => {
					if (c.type === "input_text") {
						return c.text.trim().length > 0;
					}
					return true; // Keep non-text content (images)
				});
				if (filteredContent.length === 0) continue;
				messages.push({
					role: "user",
					content: filteredContent,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;

			// Check if this message is from a different model (same provider, different model ID).
			// For such messages, tool call IDs with fc_ prefix need to be stripped to avoid
			// OpenAI's reasoning/function_call pairing validation errors.
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;

			for (const block of msg.content) {
				// Do not submit thinking blocks if the completion had an error (i.e. abort)
				if (block.type === "thinking" && msg.stopReason !== "error") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature);
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					// OpenAI requires id to be max 64 characters
					let msgId = textBlock.textSignature;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${Bun.hash.xxHash64(msgId).toString(36)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: textBlock.text.toWellFormed(), annotations: [] }],
						status: "completed",
						id: msgId,
					} satisfies ResponseOutputMessage);
					// Do not submit toolcall blocks if the completion had an error (i.e. abort)
				} else if (block.type === "toolCall" && msg.stopReason !== "error") {
					const toolCall = block as ToolCall;
					const normalized = normalizeResponsesToolCallId(toolCall.id);
					const callId = normalized.callId;
					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					let itemId: string | undefined = normalized.itemId;
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}
					knownCallIds.add(normalized.callId);
					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textResult = msg.content
				.filter(c => c.type === "text")
				.map(c => (c as { text: string }).text)
				.join("\n");
			const hasImages = msg.content.some(c => c.type === "image");
			const normalized = normalizeResponsesToolCallId(msg.toolCallId);
			if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
				continue;
			}

			// Always send function_call_output with text (or placeholder if only images)
			const hasText = textResult.length > 0;
			messages.push({
				type: "function_call_output",
				call_id: normalized.callId,
				output: (hasText ? textResult : "(see attached image)").toWellFormed(),
			});

			// If there are images and model supports them, send a follow-up user message with images
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseInputContent[] = [];

				// Add text prefix
				contentParts.push({
					type: "input_text",
					text: "Attached image(s) from tool result:",
				} satisfies ResponseInputText);

				// Add images
				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${(block as ImageContent).mimeType};base64,${(block as ImageContent).data}`,
						} satisfies ResponseInputImage);
					}
				}

				messages.push({
					role: "user",
					content: contentParts,
				});
			}
		}
		msgIndex++;
	}

	return messages;
}
