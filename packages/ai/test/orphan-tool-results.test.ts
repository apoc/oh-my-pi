import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Model, ToolCall, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { normalizeToolCallId } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression tests for the failure mode introduced when a conversation that ran
 * under Cursor's `cursor-agent` API is replayed against a provider that requires
 * strict tool_use ↔ tool_result pairing (e.g. Anthropic).
 *
 * Cursor executes native and MCP tools via exec handlers and never emits
 * `toolCall` blocks in the assistant message. The resulting tool_result
 * messages reference IDs minted by Cursor's upstream (OpenAI Responses) — these
 * IDs use `call_<callId>\nfc_<itemId>` format, which violates Anthropic's
 * `^[a-zA-Z0-9_-]+$` pattern. Replaying that history under Anthropic 400s with:
 *   "messages.N.content.0.tool_result.tool_use_id: String should match pattern"
 *
 * `transformMessages` must inject a synthetic `toolCall` block (with the same,
 * normalized id) into the preceding assistant message so downstream conversion
 * has a tool_use to pair against.
 */
describe("Orphan toolResult handling for cross-provider replay", () => {
	const anthropicModel: Model<"anthropic-messages"> = buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	});

	function buildCursorAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "Looking into it." }],
			api: "cursor-agent",
			provider: "cursor",
			model: "gpt-5.5-extra-high",
			usage: {
				input: 0,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1_000,
			...overrides,
		};
	}

	function findToolCall(content: AssistantMessage["content"], id: string): ToolCall | undefined {
		return content.find((b): b is ToolCall => b.type === "toolCall" && b.id === id);
	}

	it("injects a synthetic toolCall and rewrites invalid ids so Anthropic accepts the pair", () => {
		const cursorId = "call_hSsLqNS1sufUqpSQ1m5WYuJg\nfc_0f0ef28a999269bd016a01aba3a87081909a9b5a379f4e4585";
		const expectedId = normalizeToolCallId(cursorId);
		// Sanity: the raw id is rejected by Anthropic's pattern, the normalized one is accepted.
		expect(/^[a-zA-Z0-9_-]+$/.test(cursorId)).toBe(false);
		expect(/^[a-zA-Z0-9_-]+$/.test(expectedId)).toBe(true);

		const messages = [
			{ role: "user", content: "Please search the repo", timestamp: 0 } satisfies UserMessage,
			buildCursorAssistant(),
			{
				role: "toolResult",
				toolCallId: cursorId,
				toolName: "search",
				content: [{ type: "text", text: "found 3 hits" }],
				isError: false,
				timestamp: 1_100,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);

		// Same number of messages — we mutate the assistant in place, not insert.
		expect(transformed.length).toBe(messages.length);

		const assistant = transformed[1] as AssistantMessage;
		expect(assistant.role).toBe("assistant");
		const synthetic = findToolCall(assistant.content, expectedId);
		expect(synthetic).toBeDefined();
		expect(synthetic?.name).toBe("search");
		expect(synthetic?.arguments).toEqual({});

		const tr = transformed[2] as ToolResultMessage;
		expect(tr.role).toBe("toolResult");
		expect(tr.toolCallId).toBe(expectedId);
	});

	it("appends one synthetic toolCall per orphan, in order, to the same preceding assistant", () => {
		const ids = ["call_AAA\nfc_a", "call_BBB\nfc_b", "call_CCC\nfc_c"];
		const messages = [
			buildCursorAssistant(),
			...ids.map<ToolResultMessage>((id, idx) => ({
				role: "toolResult",
				toolCallId: id,
				toolName: idx === 0 ? "read" : idx === 1 ? "find" : "search",
				content: [{ type: "text", text: `r${idx}` }],
				isError: false,
				timestamp: 2_000 + idx,
			})),
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);
		const assistant = transformed[0] as AssistantMessage;
		const toolCalls = assistant.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls.length).toBe(3);
		expect(toolCalls.map(tc => tc.name)).toEqual(["read", "find", "search"]);
		// Order matches the orphan tool_results.
		const trIds = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult").map(m => m.toolCallId);
		expect(toolCalls.map(tc => tc.id)).toEqual(trIds);
		// All synthetic ids pass Anthropic's pattern.
		for (const tc of toolCalls) {
			expect(/^[a-zA-Z0-9_-]+$/.test(tc.id)).toBe(true);
		}
	});

	it("synthesizes a leading assistant message when an orphan tool_result has no preceding assistant", () => {
		const orphanId = "call_orphan_no_prior_assistant";
		const messages = [
			{ role: "user", content: "go", timestamp: 0 } satisfies UserMessage,
			{
				role: "toolResult",
				toolCallId: orphanId,
				toolName: "read",
				content: [{ type: "text", text: "fileA" }],
				isError: false,
				timestamp: 100,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);
		const firstAssistant = transformed.find(m => m.role === "assistant") as AssistantMessage | undefined;
		expect(firstAssistant).toBeDefined();
		expect(firstAssistant?.api).toBe(anthropicModel.api);
		expect(firstAssistant?.provider).toBe(anthropicModel.provider);
		expect(firstAssistant?.model).toBe(anthropicModel.id);
		expect(firstAssistant?.content.filter(b => b.type === "toolCall").length).toBe(1);

		// User → synthetic assistant → tool_result.
		expect(transformed[0].role).toBe("user");
		expect(transformed[1].role).toBe("assistant");
		expect(transformed[2].role).toBe("toolResult");
	});

	it("leaves well-formed conversations untouched (no synthetic toolCalls, no id rewrites)", () => {
		const validId = "toolu_well_formed_123";
		const messages = [
			{ role: "user", content: "read it", timestamp: 0 } satisfies UserMessage,
			{
				role: "assistant",
				content: [
					{ type: "text", text: "ok" },
					{ type: "toolCall", id: validId, name: "read", arguments: { path: "/x" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: anthropicModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 100,
			} satisfies AssistantMessage,
			{
				role: "toolResult",
				toolCallId: validId,
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 200,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);
		expect(transformed.length).toBe(messages.length);
		const assistant = transformed[1] as AssistantMessage;
		const toolCalls = assistant.content.filter(b => b.type === "toolCall");
		expect(toolCalls.length).toBe(1);
		expect((toolCalls[0] as ToolCall).id).toBe(validId);
		expect((transformed[2] as ToolResultMessage).toolCallId).toBe(validId);
	});

	it("synthesizes within the current turn when a user boundary separates the prior assistant", () => {
		const orphan = "call_after_user\nfc_x";
		const expected = normalizeToolCallId(orphan);
		const messages = [
			buildCursorAssistant(),
			{ role: "user", content: "new turn", timestamp: 1_050 } satisfies UserMessage,
			{
				role: "toolResult",
				toolCallId: orphan,
				toolName: "search",
				content: [{ type: "text", text: "late" }],
				isError: false,
				timestamp: 1_100,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);

		expect(transformed.length).toBe(4);
		expect((transformed[0] as AssistantMessage).content.some(block => block.type === "toolCall")).toBe(false);
		const syntheticAssistant = transformed[2] as AssistantMessage;
		expect(syntheticAssistant.role).toBe("assistant");
		expect(findToolCall(syntheticAssistant.content, expected)?.name).toBe("search");
		expect((transformed[3] as ToolResultMessage).toolCallId).toBe(expected);
	});

	it("does not let future toolCalls mask earlier orphan tool_results", () => {
		const id = "future_valid_id";
		const messages = [
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: "early result" }],
				isError: false,
				timestamp: 100,
			} satisfies ToolResultMessage,
			buildCursorAssistant({
				content: [{ type: "toolCall", id, name: "read", arguments: {} }],
				timestamp: 200,
			}),
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);

		expect(transformed.length).toBe(3);
		expect((transformed[0] as AssistantMessage).role).toBe("assistant");
		expect(findToolCall((transformed[0] as AssistantMessage).content, id)).toBeDefined();
		expect((transformed[1] as ToolResultMessage).toolCallId).toBe(id);
		const laterAssistant = transformed[2] as AssistantMessage;
		expect(findToolCall(laterAssistant.content, id)).toBeUndefined();
	});

	it("attaches orphans to the immediately preceding assistant when distinct assistants appear", () => {
		const idA = "call_for_A\nfc_a";
		const idB = "call_for_B\nfc_b";
		const expectedA = normalizeToolCallId(idA);
		const expectedB = normalizeToolCallId(idB);
		const assistantA = buildCursorAssistant({ timestamp: 1_000 });
		const assistantB = buildCursorAssistant({
			content: [{ type: "text", text: "second turn" }],
			timestamp: 2_000,
		});
		const messages = [
			assistantA,
			{
				role: "toolResult",
				toolCallId: idA,
				toolName: "read",
				content: [{ type: "text", text: "rA" }],
				isError: false,
				timestamp: 1_100,
			} satisfies ToolResultMessage,
			assistantB,
			{
				role: "toolResult",
				toolCallId: idB,
				toolName: "search",
				content: [{ type: "text", text: "rB" }],
				isError: false,
				timestamp: 2_100,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);

		const assistants = transformed.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(assistants.length).toBe(2);
		expect(findToolCall(assistants[0].content, expectedA)?.name).toBe("read");
		expect(findToolCall(assistants[0].content, expectedB)).toBeUndefined();
		expect(findToolCall(assistants[1].content, expectedB)?.name).toBe("search");
		expect(findToolCall(assistants[1].content, expectedA)).toBeUndefined();
	});

	it("falls back to replay-target provenance when no prior assistant exists at orphan time", () => {
		const orphanId = "call_orphan_with_later_assistant\nfc_x";
		const expectedOrphan = normalizeToolCallId(orphanId);
		const messages = [
			{ role: "user", content: "go", timestamp: 0 } satisfies UserMessage,
			{
				role: "toolResult",
				toolCallId: orphanId,
				toolName: "read",
				content: [{ type: "text", text: "fileA" }],
				isError: false,
				timestamp: 100,
			} satisfies ToolResultMessage,
			buildCursorAssistant({ timestamp: 200 }),
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);

		// Synthetic assistant inserted before the orphan. No prior assistant exists in
		// `result` at the time appendSyntheticFor runs, so it falls back to the replay target.
		const synthetic = transformed.find(
			(m): m is AssistantMessage =>
				m.role === "assistant" && m.content.some(b => b.type === "toolCall" && b.id === expectedOrphan),
		);
		expect(synthetic).toBeDefined();
		// Falls back to replay target since no prior assistant exists in `result`
		// at the time appendSyntheticFor is called. Acceptable: prior assistants
		// available later in the stream are not visible during forward scan.
		expect(synthetic?.api).toBe(anthropicModel.api);
	});

	it("injects every orphan when several precede any assistant (no leak to the drop path)", () => {
		// Regression: the synthetic assistant created for the FIRST orphan carries the
		// replay-target api, which used to trip the non-cursor guard for every LATER
		// orphan in the same run — so only the first was paired and the rest leaked out
		// with their raw, Anthropic-invalid ids.
		const idA = "call_orphanA\nfc_a";
		const idB = "call_orphanB\nfc_b";
		const expectedA = normalizeToolCallId(idA);
		const expectedB = normalizeToolCallId(idB);
		const messages = [
			{ role: "user", content: "go", timestamp: 0 } satisfies UserMessage,
			{
				role: "toolResult",
				toolCallId: idA,
				toolName: "read",
				content: [{ type: "text", text: "rA" }],
				isError: false,
				timestamp: 100,
			} satisfies ToolResultMessage,
			{
				role: "toolResult",
				toolCallId: idB,
				toolName: "search",
				content: [{ type: "text", text: "rB" }],
				isError: false,
				timestamp: 200,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);

		// A single synthetic assistant carries BOTH synthetic toolCalls...
		const assistants = transformed.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(assistants.length).toBe(1);
		expect(findToolCall(assistants[0].content, expectedA)?.name).toBe("read");
		expect(findToolCall(assistants[0].content, expectedB)?.name).toBe("search");
		// ...and BOTH tool_results were rewritten to normalized ids — none left raw.
		const results = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results.map(r => r.toolCallId).sort()).toEqual([expectedA, expectedB].sort());
	});

	it("is idempotent: re-running on its own output injects no duplicate toolCalls", () => {
		const cursorId = "call_dup\nfc_x";
		const expectedId = normalizeToolCallId(cursorId);
		const messages = [
			{ role: "user", content: "go", timestamp: 0 } satisfies UserMessage,
			buildCursorAssistant(),
			{
				role: "toolResult",
				toolCallId: cursorId,
				toolName: "search",
				content: [{ type: "text", text: "hit" }],
				isError: false,
				timestamp: 1_100,
			} satisfies ToolResultMessage,
		];

		const once = transformMessages(messages, anthropicModel, normalizeToolCallId);
		const twice = transformMessages(once, anthropicModel, normalizeToolCallId);

		const countCalls = (msgs: typeof once) =>
			msgs
				.filter((m): m is AssistantMessage => m.role === "assistant")
				.flatMap(m => m.content)
				.filter(b => b.type === "toolCall" && b.id === expectedId).length;
		expect(countCalls(once)).toBe(1);
		expect(countCalls(twice)).toBe(1);
	});

	it("processes only orphans when some tool_results have matching toolCalls and others do not", () => {
		const known = "toolu_known_call";
		const orphan = "call_orphan\nfc_x";
		const expectedOrphan = normalizeToolCallId(orphan);

		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: known, name: "read", arguments: { path: "/known" } }],
			api: "cursor-agent",
			provider: "cursor",
			model: "gpt-5.5-extra-high",
			usage: {
				input: 0,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1_000,
		};
		const messages = [
			assistant,
			{
				role: "toolResult",
				toolCallId: known,
				toolName: "read",
				content: [{ type: "text", text: "known result" }],
				isError: false,
				timestamp: 1_100,
			} satisfies ToolResultMessage,
			{
				role: "toolResult",
				toolCallId: orphan,
				toolName: "search",
				content: [{ type: "text", text: "orphan result" }],
				isError: false,
				timestamp: 1_200,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);
		const finalAssistant = transformed.find(m => m.role === "assistant") as AssistantMessage;
		const toolCalls = finalAssistant.content.filter((b): b is ToolCall => b.type === "toolCall");
		// Cross-provider rewrite renames `known` via the existing first pass; the orphan
		// is appended as a new synthetic toolCall with its normalized id.
		expect(toolCalls.length).toBe(2);
		expect(toolCalls[1].id).toBe(expectedOrphan);
		expect(toolCalls[1].name).toBe("search");

		const trs = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(trs.length).toBe(2);
		expect(trs[1].toolCallId).toBe(expectedOrphan);
	});

	it("normalizes duplicate orphan tool_results with the same raw id", () => {
		const rawId = "call_duplicate\nfc_x";
		const expected = normalizeToolCallId(rawId);
		const messages = [
			buildCursorAssistant(),
			{
				role: "toolResult",
				toolCallId: rawId,
				toolName: "read",
				content: [{ type: "text", text: "first" }],
				isError: false,
				timestamp: 1_100,
			} satisfies ToolResultMessage,
			{
				role: "toolResult",
				toolCallId: rawId,
				toolName: "read",
				content: [{ type: "text", text: "second" }],
				isError: false,
				timestamp: 1_101,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);
		const toolResults = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		// Both duplicates normalize to the same id; the shared second pass then collapses them
		// to exactly one provider-visible result per tool call (keeping the first), since two
		// tool_result blocks with the same tool_use_id would be invalid for Anthropic/Google/
		// OpenAI cross-provider replay — the whole reason this orphan normalization exists.
		expect(toolResults.map(tr => tr.toolCallId)).toEqual([expected]);
		expect(toolResults[0].content).toEqual([{ type: "text", text: "first" }]);
		const assistant = transformed[0] as AssistantMessage;
		expect(assistant.content.filter((b): b is ToolCall => b.type === "toolCall" && b.id === expected).length).toBe(1);
	});

	it("keeps toolCall ids known across consecutive assistants in the same turn", () => {
		const callA = "toolu_call_a";
		const callB = "toolu_call_b";
		const callC = "toolu_call_c";
		const messages = [
			buildCursorAssistant({
				content: [
					{ type: "toolCall", id: callA, name: "read", arguments: {} },
					{ type: "toolCall", id: callB, name: "search", arguments: {} },
				],
			}),
			{
				role: "toolResult",
				toolCallId: callA,
				toolName: "read",
				content: [{ type: "text", text: "a" }],
				isError: false,
				timestamp: 1_100,
			} satisfies ToolResultMessage,
			buildCursorAssistant({
				content: [{ type: "toolCall", id: callC, name: "find", arguments: {} }],
				timestamp: 1_200,
			}),
			{
				role: "toolResult",
				toolCallId: callB,
				toolName: "search",
				content: [{ type: "text", text: "b" }],
				isError: false,
				timestamp: 1_300,
			} satisfies ToolResultMessage,
			{
				role: "toolResult",
				toolCallId: callC,
				toolName: "find",
				content: [{ type: "text", text: "c" }],
				isError: false,
				timestamp: 1_301,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);
		const assistants = transformed.filter((m): m is AssistantMessage => m.role === "assistant");
		const allToolCalls = assistants.flatMap(assistant =>
			assistant.content.filter((b): b is ToolCall => b.type === "toolCall"),
		);
		expect(allToolCalls.filter(toolCall => toolCall.id === callB).length).toBe(1);
	});

	it("does not synthesize a toolCall when the source assistant is not cursor-agent (compaction/handoff artifact)", () => {
		const orphanId = "orphan-after-compaction";
		const anthropicAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage: {
				input: 0,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 50,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1_000,
		};
		const messages = [
			anthropicAssistant,
			{
				role: "toolResult",
				toolCallId: orphanId,
				toolName: "read",
				content: [{ type: "text", text: "leftover result from a folded tool_use" }],
				isError: false,
				timestamp: 1_100,
			} satisfies ToolResultMessage,
		];

		const transformed = transformMessages(messages, anthropicModel, normalizeToolCallId);

		// No synthetic toolCall injected into the preceding non-cursor assistant.
		expect((transformed[0] as AssistantMessage).content.some(block => block.type === "toolCall")).toBe(false);
		// The orphan is NOT replayed as a toolResult (would be unpaired/invalid);
		// it falls through to the pre-existing drop path instead.
		expect(transformed.some(m => m.role === "toolResult")).toBe(false);
		const note = transformed.find(
			(m): m is UserMessage =>
				m.role === "user" && typeof m.content === "string" && m.content.includes("stale-tool-result"),
		);
		expect(note).toBeDefined();
		expect(note?.content).toContain(orphanId);
	});

	it("is a no-op when normalizeToolCallId is omitted, leaving orphans for the pre-existing drop path", () => {
		const orphanId = "call_no_normalizer\nfc_x";
		const messages = [
			buildCursorAssistant(),
			{
				role: "toolResult",
				toolCallId: orphanId,
				toolName: "search",
				content: [{ type: "text", text: "found it" }],
				isError: false,
				timestamp: 1_100,
			} satisfies ToolResultMessage,
		];

		// No normalizeToolCallId argument: the orphan pre-pass must not run at all,
		// even though the source assistant is cursor-agent.
		const transformed = transformMessages(messages, anthropicModel);

		expect((transformed[0] as AssistantMessage).content.some(block => block.type === "toolCall")).toBe(false);
		expect(transformed.some(m => m.role === "toolResult")).toBe(false);
		const note = transformed.find(
			(m): m is UserMessage =>
				m.role === "user" && typeof m.content === "string" && m.content.includes("stale-tool-result"),
		);
		expect(note).toBeDefined();
	});
});
