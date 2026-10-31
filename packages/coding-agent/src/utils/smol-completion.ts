/**
 * Shared model selection and online completion loop for lightweight background
 * requests (session titles, mesh summaries): pick role candidates with their
 * retry fallback chains, then try each model until one yields a usable result.
 */
import {
	type Api,
	type AssistantMessage,
	completeSimple,
	type Message,
	type Model,
	retryTransientCompletion,
} from "@oh-my-pi/pi-ai";
import { StreamMarkupHealing } from "@oh-my-pi/pi-ai/utils/stream-markup-healing";
import { logger } from "@oh-my-pi/pi-utils";
import { cfgOffline } from "../config/auxiliary-model-policy";
import type { ModelRegistry } from "../config/model-registry";
import { roleCandidatePool } from "../config/model-roles";
import { formatModelStringWithRouting } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { cfgRetryModelFallback } from "../session/settings";
import { collectOnlineTinyCandidates, expandOnlineTinyModelFallbacks } from "../tiny/online-candidates";

export interface BackgroundModelSelection {
	/** Role whose eligibility filter builds the candidate pool. */
	pool: string;
	/** Roles whose primaries (and retry chains) are tried, in order. */
	roles: readonly string[];
	/** Session model appended (with its own fallback chain) as the last resort. */
	currentModel?: Model<Api>;
}

/**
 * Candidate models for a background request: each role's primary plus its
 * retry fallback chain, then the session model and its own chain when fallback
 * is enabled (or no role resolved). Offline mode restricts every candidate to
 * the session model's provider.
 */
export function selectBackgroundModels(
	registry: ModelRegistry,
	settings: Settings,
	selection: BackgroundModelSelection,
): Model<Api>[] {
	const currentModel = selection.currentModel;
	const offline = cfgOffline.get(settings);
	if (offline && !currentModel?.provider) return [];
	const availableModels = roleCandidatePool(selection.pool, settings, registry);
	if (availableModels.length === 0) return [];

	const models = collectOnlineTinyCandidates(selection.roles, settings, availableModels).map(
		candidate => candidate.model,
	);
	if (offline) {
		const seen = new Set(models.map(formatModelStringWithRouting));
		const sameProviderModels = availableModels.filter(model => model.provider === currentModel?.provider);
		for (const { model } of collectOnlineTinyCandidates(selection.roles, settings, sameProviderModels)) {
			const key = formatModelStringWithRouting(model);
			if (seen.has(key)) continue;
			seen.add(key);
			models.push(model);
		}
	}
	if (
		currentModel &&
		(models.length === 0 ||
			(offline && !models.some(model => model.provider === currentModel.provider)) ||
			cfgRetryModelFallback.get(settings) !== false) &&
		!models.some(model => formatModelStringWithRouting(model) === formatModelStringWithRouting(currentModel))
	) {
		// Append currentModel and expand its own chain separately — never merge it
		// into the role collection (that would apply role defaults).
		const seen = new Set(models.map(formatModelStringWithRouting));
		for (const model of expandOnlineTinyModelFallbacks(currentModel, settings, availableModels)) {
			const key = formatModelStringWithRouting(model);
			if (seen.has(key)) continue;
			seen.add(key);
			models.push(model);
		}
	}
	return offline ? models.filter(model => model.provider === currentModel?.provider) : models;
}

export interface BackgroundCompletionRequest<T> {
	models: readonly Model<Api>[];
	registry: ModelRegistry;
	systemPrompt: string[];
	/** Conversation for one attempt; may depend on the model (e.g. assistant prefill). */
	buildMessages(model: Model<Api>): Message[];
	/** Extract the result from a successful response; `undefined` advances to the next model. */
	parse(response: AssistantMessage): T | undefined;
	maxTokens: number;
	temperature?: number;
	/** Provider session id for sticky credential selection. */
	sessionId?: string;
	/** Foreground session whose active OAuth credential seeds `sessionId`. */
	credentialSourceSessionId?: string;
	/** Evaluated after credential selection so metadata reflects the chosen account. */
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	signal?: AbortSignal;
	/**
	 * Sees every response the provider billed, including attempts a transient retry
	 * replaced, e.g. to record spend. Best-effort: a throw is logged, never fails the request.
	 */
	onResponse?(response: AssistantMessage): void;
	log: {
		/** Log message prefix, e.g. `title-generator`. */
		prefix: string;
		/** Fields merged into every log record. */
		context: Record<string, unknown>;
		/** Name of the result in log messages/records, e.g. `title`. */
		resultLabel: string;
	};
}

/**
 * Try each model in order until one returns a parsable result. Missing keys,
 * provider errors, and empty results advance to the next model; aborts stop
 * the loop. Never throws.
 */
export async function completeWithBackgroundModels<T>(request: BackgroundCompletionRequest<T>): Promise<T | null> {
	const { registry, sessionId, credentialSourceSessionId, signal, log } = request;
	for (const model of request.models) {
		const modelContext = {
			...log.context,
			provider: model.provider,
			id: model.id,
			model: `${model.provider}/${model.id}`,
		};
		logger.debug(`${log.prefix}: start`, modelContext);

		if (signal?.aborted) {
			logger.debug(`${log.prefix}: aborted before attempt`, { ...modelContext, reason: "aborted" });
			return null;
		}

		try {
			if (credentialSourceSessionId && sessionId && credentialSourceSessionId !== sessionId) {
				const foregroundCredential = registry.authStorage.oauth
					.accounts(model.provider, credentialSourceSessionId)
					.find(account => account.active);
				if (foregroundCredential) {
					registry.authStorage.sessions.pin(model.provider, sessionId, foregroundCredential.credentialId);
				}
			}
			const apiKey = await registry.getApiKey(model, sessionId);
			if (!apiKey) {
				logger.warn(`${log.prefix}: no API key`, { ...modelContext, reason: "missing-api-key" });
				continue;
			}
			if (signal?.aborted) {
				logger.debug(`${log.prefix}: aborted after credential`, { ...modelContext, reason: "aborted" });
				return null;
			}
			// Resolve metadata after getApiKey so the session-sticky credential for this
			// request is already recorded; metadataResolver can then return the correct
			// account_uuid rather than the snapshot-at-call-site value.
			const metadata = request.metadataResolver?.(model.provider);
			const maxTokens = request.maxTokens;
			logger.debug(`${log.prefix}: request`, { ...modelContext, maxTokens });

			const messages = request.buildMessages(model);
			const response = await retryTransientCompletion(
				async () => {
					const message = await completeSimple(
						model,
						{ systemPrompt: request.systemPrompt, messages },
						{
							apiKey: registry.resolver(model, sessionId),
							sessionId,
							maxTokens,
							disableReasoning: true,
							temperature: request.temperature,
							metadata,
							signal,
						},
					);
					try {
						request.onResponse?.(message);
					} catch (err) {
						logger.debug(`${log.prefix}: usage report failed`, {
							...modelContext,
							error: err instanceof Error ? err.message : String(err),
						});
					}
					return message;
				},
				{ signal, provider: model.provider },
			);

			if (response.stopReason === "aborted" || signal?.aborted) {
				logger.debug(`${log.prefix}: aborted`, {
					...modelContext,
					reason: "aborted",
					stopReason: response.stopReason,
				});
				return null;
			}

			if (response.stopReason === "error") {
				logger.warn(`${log.prefix}: response error`, {
					...modelContext,
					reason: "provider-response-error",
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				});
				continue;
			}

			const result = request.parse(response);
			if (result === undefined) {
				logger.debug(`${log.prefix}: no ${log.resultLabel} returned`, {
					...modelContext,
					reason: "model-returned-none",
					usage: response.usage,
					stopReason: response.stopReason,
				});
				continue;
			}

			logger.debug(`${log.prefix}: success`, {
				...modelContext,
				[log.resultLabel]: result,
				usage: response.usage,
				stopReason: response.stopReason,
			});
			return result;
		} catch (err) {
			if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) {
				logger.debug(`${log.prefix}: aborted`, {
					...modelContext,
					reason: "aborted",
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			}
			logger.warn(`${log.prefix}: error`, {
				...modelContext,
				reason: "exception",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return null;
}

/**
 * Remove thinking markup a backend leaked into visible text despite
 * `disableReasoning`: balanced `<think>` envelopes and a reply cut off inside
 * an unterminated one.
 */
export function stripLeakedThinkingMarkup(text: string): string {
	const healer = new StreamMarkupHealing({ pattern: "thinking" });
	return healer.feed(text) + healer.flushPending();
}
