import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { $env, abortableSleep } from "@oh-my-pi/pi-utils";
import { mapEffortToAnthropicAdaptiveEffort } from "../model-thinking";
import { calculateCost } from "../models";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	RedactedThinkingContent,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import { parseStreamingJson } from "../utils/json-parse";
import type { AnthropicEffort } from "./anthropic";
import {
	applyPromptCaching,
	buildAnthropicSystemBlocks,
	convertAnthropicMessages,
	convertTools,
	disableThinkingIfToolChoiceForced,
	enforceCacheControlLimit,
	ensureMaxTokensForThinking,
	getCacheControl,
	isProviderRetryableError,
	isTransientStreamParseError,
	mapStopReason,
	normalizeCacheControlTtlOrdering,
	normalizeExtraBetas,
	PROVIDER_BASE_DELAY_MS,
	PROVIDER_MAX_RETRIES,
} from "./anthropic";

export interface AnthropicVertexOptions extends StreamOptions {
	/** Google Cloud project ID. Falls back to GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT env vars. */
	project?: string;
	/** Google Cloud region. Falls back to GOOGLE_CLOUD_LOCATION, then "us-east5". */
	region?: string;
	thinkingEnabled?: boolean;
	thinkingBudgetTokens?: number;
	effort?: AnthropicEffort;
	reasoning?: SimpleStreamOptions["reasoning"];
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	betas?: string[] | string;
	cacheRetention?: CacheRetention;
}

function resolveProject(options?: AnthropicVertexOptions): string {
	const project = options?.project ?? $env.GOOGLE_CLOUD_PROJECT ?? $env.GCLOUD_PROJECT;
	if (!project) {
		throw new Error("No Google Cloud project ID. Set GOOGLE_CLOUD_PROJECT env var or pass project in options.");
	}
	return project;
}

function resolveRegion(options?: AnthropicVertexOptions): string {
	return options?.region ?? $env.GOOGLE_CLOUD_LOCATION ?? "us-east5";
}

type Block = (ThinkingContent | RedactedThinkingContent | TextContent | (ToolCall & { partialJson: string })) & {
	index: number;
};

type AnthropicSamplingParams = MessageCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
};

// Vertex base URL is never api.anthropic.com, so 1h cache TTL won't apply.
// Using a placeholder that causes getCacheControl to use 5m TTL.
const VERTEX_BASE_URL = "https://aiplatform.googleapis.com";

function buildParams(
	model: Model<"anthropic-vertex-messages">,
	context: Context,
	options?: AnthropicVertexOptions,
): MessageCreateParamsStreaming {
	// Cast to anthropic-messages for shared utilities that accept that model type.
	const anthropicModel = model as unknown as Model<"anthropic-messages">;
	const { cacheControl } = getCacheControl(VERTEX_BASE_URL, options?.cacheRetention);

	const params: AnthropicSamplingParams = {
		model: model.id,
		messages: convertAnthropicMessages(context.messages, anthropicModel, false),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	if (options?.temperature !== undefined) params.temperature = options.temperature;
	if (options?.topP !== undefined) params.top_p = options.topP;
	if (options?.topK !== undefined) params.top_k = options.topK;

	if (context.tools) {
		params.tools = convertTools(context.tools, false);
	}

	if (options?.thinkingEnabled && model.reasoning) {
		const mode = model.thinking?.mode;
		const requestedEffort = options.reasoning;
		const effort =
			options.effort ??
			(requestedEffort ? mapEffortToAnthropicAdaptiveEffort(anthropicModel, requestedEffort) : undefined);

		if (mode === "anthropic-adaptive") {
			params.thinking = { type: "adaptive" };
			if (effort) {
				params.output_config = { effort };
			}
		} else {
			params.thinking = {
				type: "enabled",
				budget_tokens: options.thinkingBudgetTokens ?? 1024,
			};
			if (mode === "anthropic-budget-effort" && effort) {
				params.output_config = { effort };
			}
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	const systemBlocks = buildAnthropicSystemBlocks(context.systemPrompt);
	if (systemBlocks) {
		params.system = systemBlocks;
	}

	disableThinkingIfToolChoiceForced(params);
	ensureMaxTokensForThinking(params, anthropicModel);
	applyPromptCaching(params, cacheControl);
	enforceCacheControlLimit(params, 4);
	normalizeCacheControlTtlOrdering(params);

	return params;
}

export const streamAnthropicVertex: StreamFunction<"anthropic-vertex-messages"> = (
	model: Model<"anthropic-vertex-messages">,
	context: Context,
	options?: AnthropicVertexOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-vertex-messages" as Api,
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;

		try {
			const project = resolveProject(options);
			const region = resolveRegion(options);

			const extraBetas = normalizeExtraBetas(options?.betas);
			if (options?.interleavedThinking !== false) {
				extraBetas.push("interleaved-thinking-2025-05-14");
			}

			const client = new AnthropicVertex({
				projectId: project,
				region,
				...(extraBetas.length > 0 ? { defaultHeaders: { "anthropic-beta": extraBetas.join(",") } } : {}),
			});

			const params = buildParams(model, context, options);
			options?.onPayload?.(params);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${model.id}:streamRawPredict`,
				body: params,
			};

			const blocks = output.content as Block[];
			eventStream.push({ type: "start", partial: output });

			let providerRetryAttempt = 0;
			let started = false;
			do {
				const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: options?.signal });

				try {
					for await (const event of anthropicStream) {
						started = true;
						if (event.type === "message_start") {
							output.usage.input = event.message.usage.input_tokens || 0;
							output.usage.output = event.message.usage.output_tokens || 0;
							output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
							output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model as unknown as Model<"anthropic-messages">, output.usage);
						} else if (event.type === "content_block_start") {
							if (!firstTokenTime) firstTokenTime = Date.now();
							if (event.content_block.type === "text") {
								const block: Block = { type: "text", text: "", index: event.index };
								output.content.push(block);
								eventStream.push({
									type: "text_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							} else if (event.content_block.type === "thinking") {
								const block: Block = {
									type: "thinking",
									thinking: "",
									thinkingSignature: "",
									index: event.index,
								};
								output.content.push(block);
								eventStream.push({
									type: "thinking_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							} else if (event.content_block.type === "redacted_thinking") {
								const block: Block = {
									type: "redactedThinking",
									data: event.content_block.data,
									index: event.index,
								};
								output.content.push(block);
							} else if (event.content_block.type === "tool_use") {
								const block: Block = {
									type: "toolCall",
									id: event.content_block.id,
									name: event.content_block.name,
									arguments: (event.content_block.input as Record<string, unknown>) ?? {},
									partialJson: "",
									index: event.index,
								};
								output.content.push(block);
								eventStream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
						} else if (event.type === "content_block_delta") {
							if (event.delta.type === "text_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "text") {
									block.text += event.delta.text;
									eventStream.push({
										type: "text_delta",
										contentIndex: index,
										delta: event.delta.text,
										partial: output,
									});
								}
							} else if (event.delta.type === "thinking_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinking += event.delta.thinking;
									eventStream.push({
										type: "thinking_delta",
										contentIndex: index,
										delta: event.delta.thinking,
										partial: output,
									});
								}
							} else if (event.delta.type === "input_json_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "toolCall") {
									block.partialJson += event.delta.partial_json;
									block.arguments = parseStreamingJson(block.partialJson);
									eventStream.push({
										type: "toolcall_delta",
										contentIndex: index,
										delta: event.delta.partial_json,
										partial: output,
									});
								}
							} else if (event.delta.type === "signature_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
								}
							}
						} else if (event.type === "content_block_stop") {
							const index = blocks.findIndex(b => b.index === event.index);
							const block = blocks[index];
							if (block) {
								delete (block as { index?: number }).index;
								if (block.type === "text") {
									eventStream.push({
										type: "text_end",
										contentIndex: index,
										content: block.text,
										partial: output,
									});
								} else if (block.type === "thinking") {
									eventStream.push({
										type: "thinking_end",
										contentIndex: index,
										content: block.thinking,
										partial: output,
									});
								} else if (block.type === "toolCall") {
									block.arguments = parseStreamingJson(block.partialJson);
									delete (block as { partialJson?: string }).partialJson;
									eventStream.push({
										type: "toolcall_end",
										contentIndex: index,
										toolCall: block,
										partial: output,
									});
								}
							}
						} else if (event.type === "message_delta") {
							if (event.delta.stop_reason) {
								output.stopReason = mapStopReason(event.delta.stop_reason) as StopReason;
							}
							if (event.usage.input_tokens != null) output.usage.input = event.usage.input_tokens;
							if (event.usage.output_tokens != null) output.usage.output = event.usage.output_tokens;
							if (event.usage.cache_read_input_tokens != null)
								output.usage.cacheRead = event.usage.cache_read_input_tokens;
							if (event.usage.cache_creation_input_tokens != null)
								output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model as unknown as Model<"anthropic-messages">, output.usage);
						}
					}

					if (options?.signal?.aborted) {
						throw new Error("Request was aborted");
					}
					if (output.stopReason === "aborted" || output.stopReason === "error") {
						throw new Error("An unknown error occurred");
					}
					break;
				} catch (streamError) {
					const isTransient = isTransientStreamParseError(streamError);
					if (
						options?.signal?.aborted ||
						providerRetryAttempt >= PROVIDER_MAX_RETRIES ||
						(!isTransient && firstTokenTime !== undefined) ||
						(!isTransient && !isProviderRetryableError(streamError))
					) {
						throw streamError;
					}
					providerRetryAttempt++;
					const delayMs = PROVIDER_BASE_DELAY_MS * 2 ** (providerRetryAttempt - 1);
					await abortableSleep(delayMs, options?.signal);
					output.content.length = 0;
					output.stopReason = "stop";
					firstTokenTime = undefined;
					started = false;
				}
			} while (!started);

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			eventStream.push({ type: "done", reason: output.stopReason, message: output });
			eventStream.end();
		} catch (error) {
			for (const block of output.content) delete (block as { index?: number }).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = await finalizeErrorMessage(error, rawRequestDump);
			output.duration = Date.now() - startTime;
			eventStream.push({ type: "error", reason: output.stopReason, error: output });
			eventStream.end();
		}
	})();

	return eventStream;
};
