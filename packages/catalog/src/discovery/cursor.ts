import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { type } from "arktype";
import { getBundledModels } from "../models";
import { toModelSpec } from "../provider-models/bundled-references";
import type { Model, ModelSpec } from "../types";
import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "./cursor-gen/agent_pb";

const CURSOR_DEFAULT_BASE_URL = "https://api2.cursor.sh";
const CURSOR_DEFAULT_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
// Cursor's GPT-5.4 / GPT-5.5 1M variants stream up to 272k by default and
// unlock the full 1M only when the request flips MAX mode. Advertise the base
// (no-MAX) window on `contextWindow` and the MAX window via `extendedContext`.
const CURSOR_ONE_MILLION_BASE_CONTEXT_WINDOW = 272_000;
const CURSOR_ONE_MILLION_BASE_MAX_TOKENS = 64_000;
const CURSOR_ONE_MILLION_EXTENDED_CONTEXT_WINDOW = 1_000_000;
const CURSOR_ONE_MILLION_EXTENDED_MAX_TOKENS = 128_000;

/**
 * Model-id families whose native catalogs (anthropic, openai/openai-codex,
 * google) are multimodal. Cursor-only or text-only families (`composer-*`,
 * `grok-code-*`) intentionally stay outside this pattern.
 */
const CURSOR_MULTIMODAL_ID_PATTERN = /claude|gemini|gpt-|codex/;

const OptionalDisplayNameSchema = type("unknown").pipe(raw => (typeof raw === "string" ? raw : undefined));
const CursorAliasesSchema = type("unknown").pipe(raw => {
	if (Array.isArray(raw)) {
		return raw.filter((alias: unknown): alias is string => typeof alias === "string");
	}
	return [];
});

const CursorModelDetailsSchema = type({
	modelId: "string",
	displayName: OptionalDisplayNameSchema.default(undefined),
	displayNameShort: OptionalDisplayNameSchema.default(undefined),
	displayModelId: OptionalDisplayNameSchema.default(undefined),
	aliases: CursorAliasesSchema.default(() => []),
	"thinkingDetails?": "unknown",
	maxMode: "boolean = false",
});

const CursorModelsInnerSchema = type("unknown[]");
const ResilientCursorModelsSchema = type("unknown").pipe(raw => {
	const out = CursorModelsInnerSchema(raw);
	return out instanceof type.errors ? [] : out;
});

const CursorDecodedResponseSchema = type({
	models: ResilientCursorModelsSchema.default(() => []),
});

type CursorModelDetailsValue = typeof CursorModelDetailsSchema.infer;

/**
 * Options for fetching dynamic Cursor models from `GetUsableModels`.
 */
export interface CursorModelDiscoveryOptions {
	/** Cursor access token used for bearer authentication. */
	apiKey: string;
	/** Optional Cursor API base URL override. */
	baseUrl?: string;
	/** Optional client version override sent as `x-cursor-client-version`. */
	clientVersion?: string;
	/** Optional request timeout in milliseconds. */
	timeoutMs?: number;
	/** Optional list of custom Cursor model ids to include in request context. */
	customModelIds?: string[];
}

/**
 * Fetches Cursor models through `GetUsableModels` and normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchCursorUsableModels(
	options: CursorModelDiscoveryOptions,
): Promise<ModelSpec<"cursor-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	try {
		const requestPayload = create(GetUsableModelsRequestSchema, {
			customModelIds: normalizeCustomModelIds(options.customModelIds),
		});
		const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
		const baseUrl = (options.baseUrl ?? CURSOR_DEFAULT_BASE_URL).replace(/\/+$/, "");

		const responseBuffer = await fetchViaHttp2(baseUrl, body, options, timeoutMs);

		if (!responseBuffer) {
			return null;
		}
		const decoded = decodeGetUsableModelsResponse(responseBuffer);
		const parsedDecoded = CursorDecodedResponseSchema(decoded);
		if (parsedDecoded instanceof type.errors) {
			return null;
		}

		const references = createCursorReferenceMap();
		return normalizeCursorModels(parsedDecoded.models, options.baseUrl, references);
	} catch {
		return null;
	}
}

function buildRequestHeaders(options: CursorModelDiscoveryOptions): Record<string, string> {
	return {
		"content-type": "application/proto",
		te: "trailers",
		authorization: `Bearer ${options.apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": options.clientVersion ?? CURSOR_DEFAULT_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
	};
}

/** HTTP/2 transport required by Cursor API (HTTP/1.1 is rejected with 464). */
async function fetchViaHttp2(
	baseUrl: string,
	body: Uint8Array,
	options: CursorModelDiscoveryOptions,
	timeoutMs: number,
): Promise<Uint8Array | null> {
	const { promise, resolve } = Promise.withResolvers<Uint8Array | null>();
	const client = http2.connect(baseUrl);
	const timer = setTimeout(() => {
		client.destroy();
		resolve(null);
	}, timeoutMs);

	client.on("error", () => {
		clearTimeout(timer);
		resolve(null);
	});

	const req = client.request({
		":method": "POST",
		":path": CURSOR_GET_USABLE_MODELS_PATH,
		...buildRequestHeaders(options),
	});

	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		clearTimeout(timer);
		client.close();
		resolve(new Uint8Array(Buffer.concat(chunks)));
	});
	req.on("error", () => {
		clearTimeout(timer);
		client.close();
		resolve(null);
	});
	req.on("response", headers => {
		const status = Number(headers[":status"] ?? 0);
		if (status < 200 || status >= 300) {
			clearTimeout(timer);
			client.close();
			resolve(null);
		}
	});

	if (body.length > 0) {
		req.end(Buffer.from(body));
	} else {
		req.end();
	}

	return promise;
}

function normalizeCustomModelIds(customModelIds: readonly string[] | undefined): string[] {
	if (!customModelIds) {
		return [];
	}
	const normalized = new Set<string>();
	for (const value of customModelIds) {
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}
		normalized.add(trimmed);
	}
	return [...normalized];
}

function createCursorReferenceMap(): Map<string, ModelSpec<"cursor-agent">> {
	const references = new Map<string, ModelSpec<"cursor-agent">>();
	for (const model of getBundledModels("cursor")) {
		references.set(model.id, toModelSpec(model as Model<"cursor-agent">));
	}
	return references;
}

function decodeGetUsableModelsResponse(payload: Uint8Array) {
	if (payload.length === 0) {
		return null;
	}

	const framedBody = decodeConnectUnaryBody(payload);
	if (framedBody) {
		try {
			return fromBinary(GetUsableModelsResponseSchema, framedBody);
		} catch {
			return null;
		}
	}

	try {
		return fromBinary(GetUsableModelsResponseSchema, payload);
	} catch {
		return null;
	}
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) {
		return null;
	}

	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset];
		const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
		const messageLength = view.getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) {
			return null;
		}
		const compressionFlagSet = (flags & 0b0000_0001) !== 0;
		if (compressionFlagSet) {
			return null;
		}
		const endStreamFlagSet = (flags & 0b0000_0010) !== 0;
		if (!endStreamFlagSet) {
			return payload.subarray(offset + 5, frameEnd);
		}

		offset = frameEnd;
	}

	return null;
}

function normalizeCursorModels(
	models: readonly unknown[] | undefined,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
): ModelSpec<"cursor-agent">[] {
	if (!models || models.length === 0) {
		return [];
	}

	const byId = new Map<string, ModelSpec<"cursor-agent">>();
	for (const model of models) {
		const normalized = normalizeCursorModel(model, baseUrlOverride, references);
		if (!normalized) {
			continue;
		}
		byId.set(normalized.id, normalized);
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeCursorModel(
	model: unknown,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
): ModelSpec<"cursor-agent"> | null {
	const parsedModel = CursorModelDetailsSchema(model);
	if (parsedModel instanceof type.errors) {
		return null;
	}

	const details = parsedModel;
	const id = details.modelId.trim();
	if (!id) {
		return null;
	}

	const name = pickModelDisplayName(details, id);
	const reference = references.get(id);
	const reasoning = Boolean(details.thinkingDetails) || reference?.reasoning === true;

	if (reference) {
		return applyCursorDiscoveredModelPolicy({
			...reference,
			id,
			name,
			baseUrl: baseUrlOverride ?? reference.baseUrl,
			reasoning,
			cursorMaxMode: details.maxMode,
		});
	}
	// Reference-less discovery rows start from the generic Cursor defaults;
	// `applyCursorDiscoveredModelPolicy` promotes MAX-capable (GPT-5.4/5.5) and
	// native-1M (GPT-5.6) families to their real windows, so the correction lives
	// in one place and also runs on cache reads / offline fallback.
	const spec: ModelSpec<"cursor-agent"> = {
		id,
		name,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: baseUrlOverride ?? CURSOR_DEFAULT_BASE_URL,
		reasoning,
		input: inferInputFromCursorId(id),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		cursorMaxMode: details.maxMode,
	};
	return applyCursorDiscoveredModelPolicy(spec);
}

export function isCursorAgent<TApi extends string>(model: Model<TApi>): model is Model<"cursor-agent"> & Model<TApi> {
	return model.api === "cursor-agent";
}

export function isCursorMaxCapable<TApi extends string>(model: Model<TApi>): boolean {
	return isCursorAgent(model) && !!model.extendedContext;
}

export function applyCursorDiscoveredModelPolicy<
	T extends Pick<Model<"cursor-agent">, "id" | "contextWindow" | "maxTokens" | "extendedContext">,
>(model: T): T {
	if (/\bgpt-5\.6\b/.test(model.id)) {
		// GPT-5.6 (Sol/Terra/Luna) ship 1M/128k as their native base window with
		// no MAX-mode unlock. Correct only the values we know are wrong — the
		// generic discovery default or null (stale static/cache rows written
		// before this family was recognized) — and never set `extendedContext`,
		// since there is no larger window to gate.
		const contextWindow =
			model.contextWindow == null || model.contextWindow === DEFAULT_CONTEXT_WINDOW
				? CURSOR_ONE_MILLION_EXTENDED_CONTEXT_WINDOW
				: model.contextWindow;
		const maxTokens =
			model.maxTokens == null || model.maxTokens === DEFAULT_MAX_TOKENS
				? CURSOR_ONE_MILLION_EXTENDED_MAX_TOKENS
				: model.maxTokens;
		if (
			model.contextWindow === contextWindow &&
			model.maxTokens === maxTokens &&
			model.extendedContext === undefined
		) {
			return model;
		}
		return { ...model, contextWindow, maxTokens, extendedContext: undefined };
	}
	if (!isCursorMaxCapableModel(model)) {
		return model;
	}
	// Derive the base (no-MAX) window. Only correct the two values we know are
	// wrong: the generic discovery default, stale static/cache entries that
	// advertised the 1M MAX window as the normal context window, and null
	// (absent from models.dev / stale cache). Any other explicit window is
	// preserved as the real base so a future Cursor variant shipping a different
	// base isn't silently clobbered to 272k.
	const baseContextWindow =
		model.contextWindow == null ||
		model.contextWindow === DEFAULT_CONTEXT_WINDOW ||
		model.contextWindow === CURSOR_ONE_MILLION_EXTENDED_CONTEXT_WINDOW
			? CURSOR_ONE_MILLION_BASE_CONTEXT_WINDOW
			: model.contextWindow;
	const baseMaxTokens =
		model.maxTokens == null ||
		model.maxTokens === DEFAULT_MAX_TOKENS ||
		model.maxTokens === CURSOR_ONE_MILLION_EXTENDED_MAX_TOKENS
			? CURSOR_ONE_MILLION_BASE_MAX_TOKENS
			: model.maxTokens;
	// Already correctly decorated — return the same reference so repeated calls
	// (e.g. `#applyRuntimeProviderOverrides` on every registry mutation, or
	// `modelPostProcess` on every resolveProviderModels call) don't allocate.
	if (
		model.contextWindow === baseContextWindow &&
		model.maxTokens === baseMaxTokens &&
		model.extendedContext !== undefined &&
		model.extendedContext.baseContextWindow === baseContextWindow &&
		model.extendedContext.baseMaxTokens === baseMaxTokens
	) {
		return model;
	}
	return {
		...model,
		contextWindow: baseContextWindow,
		maxTokens: baseMaxTokens,
		extendedContext: {
			contextWindow: CURSOR_ONE_MILLION_EXTENDED_CONTEXT_WINDOW,
			maxTokens: CURSOR_ONE_MILLION_EXTENDED_MAX_TOKENS,
			baseContextWindow,
			baseMaxTokens,
		},
	};
}

// All GPT-5.4 and GPT-5.5 cursor-agent models support MAX mode (272k base,
// 1M when max_mode=true). The family is identified purely by model id —
// Cursor no longer advertises "1M" in display names.
function isCursorMaxCapableModel(model: Pick<Model<"cursor-agent">, "id">): boolean {
	return /\bgpt-5\.(?:4|5)\b/.test(model.id);
}

function pickModelDisplayName(model: CursorModelDetailsValue, fallbackId: string): string {
	const candidates = [model.displayName, model.displayNameShort, model.displayModelId, ...model.aliases, fallbackId];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return fallbackId;
}

/**
 * Infers input modalities for Cursor models without a bundled reference.
 *
 * `GetUsableModels` carries no per-model modality metadata, so classification
 * falls back to the model family: families that are multimodal in OMP's own
 * native catalogs accept images, everything else stays text-only. Mirrors
 * `inferInputFromGeminiId` in ./gemini.ts.
 */
function inferInputFromCursorId(id: string): ("text" | "image")[] {
	if (CURSOR_MULTIMODAL_ID_PATTERN.test(id.toLowerCase())) {
		return ["text", "image"];
	}
	return ["text"];
}
