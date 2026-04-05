import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";

import {
	BINDING_URI_SCHEMES,
	DEFAULT_THINNING_CONFIG,
	THINNED_STUB_PREFIX,
	thinToolOutputs,
} from "../src/session/compaction/context-thinning";

// ============================================================================
// Helpers
// ============================================================================

function toolResult(toolName: string, text: string, opts?: { prunedAt?: number }): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...(opts?.prunedAt !== undefined ? { prunedAt: opts.prunedAt } : {}),
	} as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AgentMessage;
}

function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

/**
 * Build a linked assistant+toolResult pair for a `read` call.
 * The assistant message carries the ToolCall block; the tool result carries
 * the matching toolCallId. Together they exercise the per-invocation path
 * lookup that guards binding-context URIs.
 */
function readPair(path: string, resultText: string): AgentMessage[] {
	const callId = `call_read_${Math.random().toString(36).slice(2, 8)}`;
	const assistantWithCall: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: callId,
				name: "read",
				arguments: { path },
			},
		],
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: resultText }],
		isError: false,
		timestamp: Date.now(),
	};
	return [assistantWithCall as AgentMessage, result as AgentMessage];
}

// ============================================================================
// Tests
// ============================================================================

describe("thinToolOutputs", () => {
	it("returns unchanged when disabled", () => {
		const messages = [userMsg("hello"), assistantMsg("hi"), toolResult("bash", "x".repeat(10000))];
		const result = thinToolOutputs(messages, { enabled: false });
		expect(result.thinnedCount).toBe(0);
		expect(result.messages).toBe(messages); // same reference
	});

	it("returns unchanged for empty messages", () => {
		const result = thinToolOutputs([]);
		expect(result.thinnedCount).toBe(0);
		expect(result.messages).toEqual([]);
	});

	it("keeps all results when count <= keepRecent", () => {
		const messages = [
			userMsg("q"),
			assistantMsg("a"),
			toolResult("bash", "output1"),
			toolResult("bash", "output2"),
			toolResult("bash", "output3"),
		];
		const result = thinToolOutputs(messages, { keepRecent: 5 });
		expect(result.thinnedCount).toBe(0);
	});

	it("thins oldest tool results beyond keepRecent", () => {
		const largeOutput = "x".repeat(4000); // ~1000 tokens
		const messages = [
			userMsg("start"),
			assistantMsg("ok"),
			toolResult("bash", largeOutput), // oldest eligible - should be thinned
			toolResult("bash", largeOutput), // 2nd oldest - should be thinned
			toolResult("bash", "recent1"), // kept
			toolResult("bash", "recent2"), // kept
		];

		const result = thinToolOutputs(messages, { keepRecent: 2, thinnableTools: ["bash", "grep", "read", "skill"] });

		expect(result.thinnedCount).toBe(2);
		expect(result.estimatedTokensSaved).toBeGreaterThan(0);

		// Original messages not mutated
		const origTr = messages[2] as ToolResultMessage;
		expect(origTr.content[0]).toHaveProperty("text", largeOutput);

		// Thinned messages have stubs
		const thinnedTr = result.messages[2] as ToolResultMessage;
		expect(thinnedTr.content).toHaveLength(1);
		expect((thinnedTr.content[0] as { type: "text"; text: string }).text).toStartWith(THINNED_STUB_PREFIX);

		// toolCallId must survive stubbing — required for Anthropic tool_use_id linkage.
		// A regression that drops the spread in favor of a fresh literal would ship silently.
		expect(thinnedTr.toolCallId).toBe((messages[2] as ToolResultMessage).toolCallId);
		expect(thinnedTr.toolName).toBe((messages[2] as ToolResultMessage).toolName);

		// Recent messages preserved
		const recentTr = result.messages[4] as ToolResultMessage;
		expect((recentTr.content[0] as { type: "text"; text: string }).text).toBe("recent1");
	});

	it("skips tools not on allowlist", () => {
		const messages = [
			toolResult("read", "file content".repeat(500)), // on allowlist
			toolResult("bash", "output".repeat(500)), // on allowlist
			toolResult("skill", "skill content".repeat(500)), // NOT on allowlist
			toolResult("bash", "recent"), // kept (keepRecent=1)
		];

		// Only bash and read are thinnable; skill is not on the list
		const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "read"] });

		// read and first bash thinned, skill preserved, last bash kept by keepRecent
		expect(result.thinnedCount).toBe(2);

		// skill left intact
		const skillTr = result.messages[2] as ToolResultMessage;
		expect(skillTr.content[0]).toHaveProperty("text");
		expect((skillTr.content[0] as { text: string }).text).toContain("skill content");
	});

	it("skips already-pruned results", () => {
		const messages = [
			toolResult("bash", "[Output truncated - 5000 tokens]", { prunedAt: Date.now() - 60000 }),
			toolResult("bash", "recent output"),
		];

		const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "grep", "read", "skill"] });
		expect(result.thinnedCount).toBe(0); // pruned one is skipped, only 1 eligible <= keepRecent
	});

	it("does not mutate original message objects", () => {
		const original = toolResult("bash", "x".repeat(2000));
		const originalContent = (original as ToolResultMessage).content;
		const messages = [original, toolResult("bash", "kept")];

		thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "grep", "read", "skill"] });

		// Original message content unchanged
		expect((messages[0] as ToolResultMessage).content).toBe(originalContent);
	});

	it("estimates token savings correctly", () => {
		// 4000 chars = ~1000 tokens, stub is ~12 tokens
		const text = "a".repeat(4000);
		const messages = [toolResult("grep", text), toolResult("grep", "kept")];

		const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "grep", "read", "skill"] });
		// Original: 4000/4 = 1000 tokens. Stub: ~40 chars / 4 = ~10 tokens. Savings: ~990
		expect(result.estimatedTokensSaved).toBeGreaterThan(900);
		expect(result.estimatedTokensSaved).toBeLessThan(1100);
	});

	it("handles mixed message types correctly", () => {
		const messages: AgentMessage[] = [
			userMsg("query"),
			assistantMsg("thinking..."),
			toolResult("bash", "x".repeat(2000)),
			userMsg("follow up"),
			assistantMsg("more"),
			toolResult("grep", "y".repeat(2000)),
			toolResult("bash", "z".repeat(2000)),
			toolResult("bash", "recent"),
		];

		const result = thinToolOutputs(messages, { keepRecent: 2, thinnableTools: ["bash", "grep", "read", "skill"] });

		// 4 eligible results, keep 2 most recent -> thin 2
		expect(result.thinnedCount).toBe(2);

		// Non-tool messages untouched
		expect(result.messages[0]).toBe(messages[0]);
		expect(result.messages[1]).toBe(messages[1]);
		expect(result.messages[3]).toBe(messages[3]);
	});

	it("uses default config when no config provided", () => {
		// Need > DEFAULT_THINNING_CONFIG.keepRecent eligible results to see thinning.
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 12; i++) {
			messages.push(toolResult("bash", `output ${i}`.repeat(200)));
		}

		const result = thinToolOutputs(messages);
		expect(result.thinnedCount).toBe(12 - DEFAULT_THINNING_CONFIG.keepRecent);
	});

	it("skips tool results with empty content", () => {
		const emptyResult = {
			role: "toolResult" as const,
			toolCallId: "call_empty",
			toolName: "bash",
			content: [],
			isError: false,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		const messages = [emptyResult, toolResult("bash", "kept")];
		const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash", "grep", "read", "skill"] });
		expect(result.thinnedCount).toBe(0);
	});

	it("second pass on thinned output is a no-op (idempotency)", () => {
		const largeOutput = "x".repeat(4000); // ~1000 tokens — well above the stub's ~10 tokens
		const messages: AgentMessage[] = [
			toolResult("bash", largeOutput),
			toolResult("bash", largeOutput),
			toolResult("bash", largeOutput),
			toolResult("bash", "recent"),
		];

		const first = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash"] });
		expect(first.thinnedCount).toBe(3);

		// Feed the output back in — the stubs must NOT be re-thinned.
		const second = thinToolOutputs(first.messages, { keepRecent: 1, thinnableTools: ["bash"] });
		expect(second.thinnedCount).toBe(0);
		expect(second.estimatedTokensSaved).toBe(0);

		// Each stubbed message is preserved by reference (the idempotency guard runs
		// before any cloning, so the output array is the same reference as the input).
		expect(second.messages[0]).toBe(first.messages[0]);
		expect(second.messages[1]).toBe(first.messages[1]);
	});

	it("skips payloads where stubbing would be a net loss (size floor)", () => {
		// Mix large (worth thinning) and tiny (stub template is heavier).
		// Tiny payloads — 2 chars — would estimate to 1 token and be replaced by a
		// ~10-token stub. Without the size floor, thinning would INFLATE the request.
		const messages: AgentMessage[] = [
			toolResult("bash", "ok"), // tiny — must NOT be stubbed
			toolResult("bash", "x".repeat(4000)), // large — gets stubbed
			toolResult("bash", "ok"), // tiny — must NOT be stubbed
			toolResult("bash", "x".repeat(4000)), // kept by keepRecent
		];

		const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["bash"] });

		// Only the large middle payload is thinned. The two tiny entries are
		// eligible but below the size floor, so they stay intact.
		expect(result.thinnedCount).toBe(1);

		expect((result.messages[0] as ToolResultMessage).content[0]).toHaveProperty("text", "ok");
		expect((result.messages[2] as ToolResultMessage).content[0]).toHaveProperty("text", "ok");
		expect(((result.messages[1] as ToolResultMessage).content[0] as { text: string }).text).toStartWith(
			THINNED_STUB_PREFIX,
		);
	});

	describe("read tool — per-invocation binding-URI protection", () => {
		const LARGE = "x".repeat(4000); // ~1000 tokens, well above size floor

		it("preserves skill:// reads regardless of age", () => {
			const [callMsg, resultMsg] = readPair("skill://my-skill/SKILL.md", LARGE);
			// Only one read result; plus enough other results to push it past keepRecent.
			const others: AgentMessage[] = Array.from({ length: 15 }, (_, i) =>
				toolResult("bash", `output ${i}`.repeat(100)),
			);
			const messages = [callMsg, resultMsg, ...others];

			const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["read", "bash"] });

			// The read result must be intact — binding URI.
			const readResult = result.messages[1] as ToolResultMessage;
			expect((readResult.content[0] as { text: string }).text).toBe(LARGE);
			// The bash results beyond keepRecent should be thinned.
			expect(result.thinnedCount).toBeGreaterThan(0);
		});

		it("preserves rule:// and memory:// reads", () => {
			const [callRule, resultRule] = readPair("rule://no-console", LARGE);
			const [callMem, resultMem] = readPair("memory://root", LARGE);
			// One bash result as the recent keeper, so both reads are old.
			const messages = [callRule, resultRule, callMem, resultMem, toolResult("bash", LARGE)];

			const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["read", "bash"] });

			// rule:// and memory:// stay intact.
			expect((result.messages[1] as ToolResultMessage).content[0]).toHaveProperty("text", LARGE);
			expect((result.messages[3] as ToolResultMessage).content[0]).toHaveProperty("text", LARGE);
			// bash result is the only kept-by-keepRecent, so it is also intact.
			expect(result.thinnedCount).toBe(0);
		});

		it("thins regular file-path reads (non-binding)", () => {
			const [callFile, resultFile] = readPair("/Users/me/project/src/main.ts", LARGE);
			const messages = [callFile, resultFile, toolResult("bash", LARGE)];

			const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["read", "bash"] });

			// File read is old and non-binding — gets thinned.
			const fileResult = result.messages[1] as ToolResultMessage;
			expect((fileResult.content[0] as { text: string }).text).toStartWith(THINNED_STUB_PREFIX);
			expect(result.thinnedCount).toBe(1);
		});

		it("thins re-fetchable internal URIs (agent://, artifact://, local://)", () => {
			const schemes = ["agent://abc123", "artifact://xyz", "local://PLAN.md", "jobs://job1", "mcp://server/res"];
			for (const uri of schemes) {
				const [callMsg, resultMsg] = readPair(uri, LARGE);
				const messages = [callMsg, resultMsg, toolResult("bash", LARGE)];
				const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["read", "bash"] });
				const readResult = result.messages[1] as ToolResultMessage;
				expect((readResult.content[0] as { text: string }).text).toStartWith(THINNED_STUB_PREFIX);
			}
		});

		it("BINDING_URI_SCHEMES covers exactly skill, rule, memory", () => {
			// Compile-time regression: if someone adds a new binding scheme they
			// must add a test too. This assertion catches silent additions or removals.
			expect(BINDING_URI_SCHEMES).toEqual(["skill://", "rule://", "memory://"]);
		});

		it("defaults to thinnable when read call not found in history (partial/restored session)", () => {
			// No assistant message with a matching ToolCall — orphan tool result.
			const orphan: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_orphan",
				toolName: "read",
				content: [{ type: "text", text: LARGE }],
				isError: false,
				timestamp: Date.now(),
			};
			const messages = [orphan as AgentMessage, toolResult("bash", LARGE)];

			const result = thinToolOutputs(messages, { keepRecent: 1, thinnableTools: ["read", "bash"] });

			// Unknown path defaults to thinnable — safer than preserving all unresolved reads.
			const readResult = result.messages[0] as ToolResultMessage;
			expect((readResult.content[0] as { text: string }).text).toStartWith(THINNED_STUB_PREFIX);
		});
	});
});
