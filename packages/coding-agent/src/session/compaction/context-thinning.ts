/**
 * Pre-send tool output thinning.
 *
 * Reduces context size by replacing old, non-critical tool results with
 * lightweight stubs before every LLM call (via the transformContext hook).
 * Unlike pruning.ts, this does NOT mutate session entries — it operates
 * exclusively on the ephemeral message array constructed for each API call.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { DEFAULT_THINNABLE_TOOLS } from "../../config/settings-schema";

export interface ThinningConfig {
	enabled: boolean;
	/** Number of recent tool results to keep intact. */
	keepRecent: number;
	/**
	 * Allowlist of tool names whose results may be thinned.
	 * Tools NOT on this list are always preserved — safe default for unknown
	 * MCP/extension tools whose output may be expensive or non-reproducible.
	 */
	thinnableTools: string[];
}

export interface ThinningResult {
	messages: AgentMessage[];
	thinnedCount: number;
	estimatedTokensSaved: number;
}

export const DEFAULT_THINNING_CONFIG: ThinningConfig = {
	enabled: true,
	// ~1-2 heavy turns worth of tool results (debugging sessions average 5-8 calls/turn).
	// Conservative enough to rarely destroy needed context; aggressive enough to
	// delay compaction by several turns in typical sessions.
	keepRecent: 5,
	// Canonical list lives in settings-schema.ts so the schema default and this runtime
	// default cannot drift. See DEFAULT_THINNABLE_TOOLS for the inclusion criterion.
	thinnableTools: [...DEFAULT_THINNABLE_TOOLS],
};

/** Sentinel prefix used in stub text — importable for test assertions. */
export const THINNED_STUB_PREFIX = "[Prior output cleared";

/**
 * URI scheme prefixes whose `read` results must NEVER be thinned, regardless
 * of age or position in the context window.
 *
 * These schemes load **binding context** — content the model treats as active
 * instructions or ground-truth facts it committed to for the rest of the
 * session. Replacing them with a stub mid-task causes the model to silently
 * violate procedures, ignore constraints, or hallucinate recalled facts.
 *
 * - `skill://`  — step-by-step procedures the model is executing
 * - `rule://`   — ambient constraints active for the entire session
 * - `memory://` — recalled project facts that ground the model's reasoning
 *
 * All other `read` targets (regular file paths, `agent://`, `artifact://`,
 * `jobs://`, `local://`, `mcp://`, `pi://`) ARE thinnable: the model read
 * the data, extracted understanding into its own messages, and can re-fetch
 * cheaply without violating any standing commitment.
 */
export const BINDING_URI_SCHEMES: readonly string[] = ["skill://", "rule://", "memory://"];

function isBindingReadPath(path: string): boolean {
	return BINDING_URI_SCHEMES.some(scheme => path.startsWith(scheme));
}

/**
 * Replace old tool-result contents with a compact stub before sending
 * messages to the LLM.
 *
 * Runs before every API call via the `transformContext` hook. Preserves
 * the most recent `config.keepRecent` eligible results and results from
 * tools not on the `thinnableTools` allowlist.
 *
 * Special case: `read` results for binding-context URIs (skill://, rule://,
 * memory://) are always preserved regardless of age, because those reads
 * load instructions and constraints the model has committed to follow.
 *
 * Does NOT mutate the input array or any of its elements.
 */
export function thinToolOutputs(messages: AgentMessage[], config?: Partial<ThinningConfig>): ThinningResult {
	const cfg: ThinningConfig = { ...DEFAULT_THINNING_CONFIG, ...config };

	if (!cfg.enabled || messages.length === 0) {
		return { messages, thinnedCount: 0, estimatedTokensSaved: 0 };
	}

	// Build a lookup of read-call paths by toolCallId so the eligibility loop
	// can skip read results that loaded binding-context URIs.
	// Scanning all assistant messages is O(n) but thinning is already O(n) and
	// message count is bounded by the context window.
	const readCallPaths = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const block of (msg as AssistantMessage).content) {
			if (block.type !== "toolCall") continue;
			const tc = block as ToolCall;
			if (tc.name === "read") {
				const path = tc.arguments?.path;
				if (typeof path === "string") {
					readCallPaths.set(tc.id, path);
				}
			}
		}
	}

	// Collect indices of thinning-eligible tool results in order.
	const eligibleIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "toolResult") continue;
		const tr = msg as ToolResultMessage;
		// Skip already-pruned entries — pruning owns those.
		if (tr.prunedAt !== undefined) continue;
		// Skip tools not on the allowlist — unknown tools are preserved by default.
		if (!cfg.thinnableTools.includes(tr.toolName)) continue;
		// Skip results with no content (nothing to save).
		if (!tr.content || tr.content.length === 0) continue;
		// Idempotency: skip results that are already a thinning stub. Without
		// this guard, a chained thinning call would rewrite the embedded token
		// count into a lie and spam the caller's debug log on every turn.
		const firstBlock = tr.content[0];
		if (firstBlock.type === "text" && firstBlock.text.startsWith(THINNED_STUB_PREFIX)) continue;
		// Per-invocation guard for the read tool: skip results that loaded
		// binding-context URIs (skill://, rule://, memory://). The allowlist
		// check above admits `read`, but these specific reads must stay intact
		// because the model treats their content as instructions it committed
		// to follow for the rest of the session. If the matching call is not
		// found (partial/restored history), default to thinnable — unknown is
		// safer than permanently retaining all unresolved reads.
		if (tr.toolName === "read") {
			const path = readCallPaths.get(tr.toolCallId);
			if (path !== undefined && isBindingReadPath(path)) continue;
		}
		eligibleIndices.push(i);
	}

	// Nothing to thin if we have keepRecent or fewer eligible results.
	if (eligibleIndices.length <= cfg.keepRecent) {
		return { messages, thinnedCount: 0, estimatedTokensSaved: 0 };
	}

	// Indices of results that will be replaced (everything before the tail).
	const toThinIndices = new Set(eligibleIndices.slice(0, eligibleIndices.length - cfg.keepRecent));

	const result = messages.slice(); // shallow copy of the outer array
	let thinnedCount = 0;
	let estimatedTokensSaved = 0;

	for (const idx of toThinIndices) {
		const tr = messages[idx] as ToolResultMessage;

		// Estimate original size (chars / 4, same heuristic as estimateTokens).
		let chars = 0;
		for (const block of tr.content) {
			if (block.type === "text") {
				chars += block.text.length;
			} else if (block.type === "image") {
				chars += 4800; // mirrors estimateTokens image constant
			}
		}
		const originalTokens = Math.ceil(chars / 4);

		const stubText = `${THINNED_STUB_PREFIX} — ${originalTokens} tokens]`;
		const stubTokens = Math.ceil(stubText.length / 4);

		// Size floor: skip when the stub would be as large as (or larger than)
		// the original payload. Common for short bash/edit/write confirmations
		// where the stub template itself is heavier than the content it would
		// replace. Without this guard, thinning a small result is a net loss.
		if (originalTokens <= stubTokens) continue;

		// New message object — never mutate the original.
		const thinned: ToolResultMessage = {
			...tr,
			content: [{ type: "text", text: stubText }],
		};

		result[idx] = thinned;
		thinnedCount++;
		estimatedTokensSaved += originalTokens - stubTokens;
	}

	return { messages: result, thinnedCount, estimatedTokensSaved };
}
