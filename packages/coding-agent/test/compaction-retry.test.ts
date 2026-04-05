import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";

import {
	dropOldestGroups,
	generateSummaryWithRetry,
	groupByUserTurn,
	type SummaryOptions,
} from "../src/session/compaction/compaction";

// ============================================================================
// Helpers
// ============================================================================

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistant(text: string): AgentMessage {
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

function toolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
		toolName: "bash",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function assistantText(msg: AgentMessage): string {
	if (msg.role !== "assistant") return "";
	const content = (msg as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const first = content[0] as { type?: string; text?: string } | undefined;
		return first?.type === "text" ? (first.text ?? "") : "";
	}
	return "";
}

function userText(msg: AgentMessage): string {
	if (msg.role !== "user") return "";
	const content = (msg as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const first = content[0] as { type?: string; text?: string } | undefined;
		return first?.type === "text" ? (first.text ?? "") : "";
	}
	return "";
}

// ============================================================================
// groupByUserTurn
// ============================================================================

describe("groupByUserTurn", () => {
	it("groups a conversation at user boundaries, not assistant boundaries", () => {
		const messages = [user("q1"), assistant("a1"), toolResult("r1"), user("q2"), assistant("a2")];

		const groups = groupByUserTurn(messages);
		expect(groups).toHaveLength(2);
		expect(groups[0]).toHaveLength(3);
		expect(groups[0][0].role).toBe("user");
		expect(userText(groups[0][0])).toBe("q1");
		expect(groups[0][1].role).toBe("assistant");
		expect(groups[0][2].role).toBe("toolResult");

		expect(groups[1]).toHaveLength(2);
		expect(groups[1][0].role).toBe("user");
		expect(userText(groups[1][0])).toBe("q2");
		expect(groups[1][1].role).toBe("assistant");
	});

	it("groups a user's prompt with its OWN response, not the previous assistant", () => {
		// Regression test: the old grouping bundled a user prompt with the PREVIOUS
		// assistant, so dropping would discard the prompt alongside the wrong response.
		// The new grouping must keep each prompt attached to the response it triggered.
		const messages = [user("q1"), assistant("a1"), user("q2"), assistant("a2")];

		const groups = groupByUserTurn(messages);
		expect(groups).toHaveLength(2);
		// Group 0: q1 + a1 (q1 is the prompt for a1)
		expect(userText(groups[0][0])).toBe("q1");
		expect(assistantText(groups[0][1])).toBe("a1");
		// Group 1: q2 + a2 (q2 is the prompt for a2, NOT grouped with a1)
		expect(userText(groups[1][0])).toBe("q2");
		expect(assistantText(groups[1][1])).toBe("a2");
	});

	it("puts leading non-user messages in the first group", () => {
		// Orphan assistant at the start (rare, but can happen with session restore).
		const messages = [assistant("orphan"), user("q1"), assistant("a1")];

		const groups = groupByUserTurn(messages);
		expect(groups).toHaveLength(2);
		expect(groups[0]).toHaveLength(1);
		expect(groups[0][0].role).toBe("assistant");
		expect(groups[1]).toHaveLength(2);
		expect(groups[1][0].role).toBe("user");
	});

	it("handles empty input", () => {
		expect(groupByUserTurn([])).toEqual([]);
	});

	it("handles single user message as one group", () => {
		const groups = groupByUserTurn([user("only")]);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toHaveLength(1);
	});

	it("puts consecutive user messages into separate groups", () => {
		const messages = [user("q1"), user("q2"), user("q3")];

		const groups = groupByUserTurn(messages);
		expect(groups).toHaveLength(3);
		expect(userText(groups[0][0])).toBe("q1");
		expect(userText(groups[1][0])).toBe("q2");
		expect(userText(groups[2][0])).toBe("q3");
	});

	it("keeps the assistant and its tool results in the user's group", () => {
		const messages = [
			user("start"),
			assistant("using tools"),
			toolResult("r1"),
			toolResult("r2"),
			user("next"),
			assistant("done"),
		];

		const groups = groupByUserTurn(messages);
		expect(groups).toHaveLength(2);
		// Group 0: user + assistant + 2 tool results (4 items)
		expect(groups[0]).toHaveLength(4);
		expect(userText(groups[0][0])).toBe("start");
		expect(groups[0][3].role).toBe("toolResult");
		// Group 1: user + assistant (2 items)
		expect(groups[1]).toHaveLength(2);
		expect(userText(groups[1][0])).toBe("next");
	});

	it("produces a single group for a single-user-prompt tool loop", () => {
		// A user sends one prompt and the agent does many tool calls.
		// This is the explicit limitation documented on groupByUserTurn: the whole
		// session is ONE cycle and cannot be partially dropped.
		const messages = [
			user("do it"),
			assistant("calling tools"),
			toolResult("r1"),
			toolResult("r2"),
			assistant("more"),
			toolResult("r3"),
			assistant("done"),
		];

		const groups = groupByUserTurn(messages);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toHaveLength(messages.length);
	});

	it("treats bashExecution / branchSummary / custom as turn boundaries (aligned with findTurnStartIndex)", () => {
		// Regression test: before the alignment fix, only `role === user` was a
		// turn boundary. Sessions starting with `!bash` or a branch-switch marker
		// collapsed into an undroppable prelude group, so the retry wrapper could
		// not trim bash-heavy early history when summarization itself overflowed.
		const bashExec = {
			role: "bashExecution",
			command: "ls",
			output: "x",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const branchSum = {
			role: "branchSummary",
			summary: "prior branch",
			fromId: "b1",
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const customMsg = {
			role: "custom",
			customType: "ext",
			content: "hello",
			display: true,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		const messages = [bashExec, assistant("a1"), branchSum, assistant("a2"), customMsg, assistant("a3")];

		const groups = groupByUserTurn(messages);
		expect(groups).toHaveLength(3);
		expect(groups[0][0].role).toBe("bashExecution");
		expect(groups[1][0].role).toBe("branchSummary");
		expect(groups[2][0].role).toBe("custom");
	});
});

// ============================================================================
// dropOldestGroups
// ============================================================================

describe("dropOldestGroups", () => {
	it("returns undefined for fewer than 2 groups", () => {
		expect(dropOldestGroups([user("only")], 0.5)).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		expect(dropOldestGroups([], 0.5)).toBeUndefined();
	});

	it("returns undefined for a single-user-prompt tool loop (no droppable unit)", () => {
		const messages = [user("do it"), assistant("a1"), toolResult("r1"), assistant("a2")];
		expect(dropOldestGroups(messages, 0.5)).toBeUndefined();
	});

	it("drops the oldest user\u2192response cycle and keeps newer cycles intact", () => {
		const messages = [
			user("q1"),
			assistant("a1"), // group 0
			user("q2"),
			assistant("a2"), // group 1
			user("q3"),
			assistant("a3"), // group 2
		];

		// 3 groups, dropFraction=0.34 -> max(1, floor(1.02)) = 1. Drop group 0.
		const result = dropOldestGroups(messages, 0.34);
		expect(result).toBeDefined();
		expect(result).toHaveLength(4);
		// First kept message is q2 (the dropped user-response pair q1/a1 is gone).
		expect(result![0].role).toBe("user");
		expect(userText(result![0])).toBe("q2");
		expect(assistantText(result![1])).toBe("a2");
		expect(userText(result![2])).toBe("q3");
		expect(assistantText(result![3])).toBe("a3");
		// q1 and a1 must be gone — this is the invariant the old grouping violated.
		expect(result!.some(m => userText(m) === "q1")).toBe(false);
		expect(result!.some(m => assistantText(m) === "a1")).toBe(false);
	});

	it("dropping 50% of groups removes half the cycles", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 6; i++) {
			messages.push(user(`q${i}`));
			messages.push(assistant(`a${i}`));
		}
		// 6 groups, drop 50% -> 3 groups dropped.
		const result = dropOldestGroups(messages, 0.5);
		expect(result).toBeDefined();
		expect(result).toHaveLength(6); // 3 cycles × 2 messages
		// The oldest 3 cycles (q0-a0, q1-a1, q2-a2) must be gone.
		for (let i = 0; i < 3; i++) {
			expect(result!.some(m => userText(m) === `q${i}`)).toBe(false);
			expect(result!.some(m => assistantText(m) === `a${i}`)).toBe(false);
		}
		// The newest 3 cycles must survive.
		for (let i = 3; i < 6; i++) {
			expect(result!.some(m => userText(m) === `q${i}`)).toBe(true);
			expect(result!.some(m => assistantText(m) === `a${i}`)).toBe(true);
		}
	});

	it("drops leading non-user prelude while keeping real user cycles", () => {
		// Orphan assistant at start forms group 0; real user cycles form groups 1+.
		const messages = [
			assistant("orphan"), // group 0
			user("q1"),
			assistant("a1"), // group 1
			user("q2"),
			assistant("a2"), // group 2
		];

		// 3 groups, drop 0.34 -> 1. Drop group 0 (the orphan).
		const result = dropOldestGroups(messages, 0.34);
		expect(result).toBeDefined();
		expect(result![0].role).toBe("user");
		expect(userText(result![0])).toBe("q1");
		// The orphan assistant is gone.
		expect(result!.some(m => assistantText(m) === "orphan")).toBe(false);
	});

	it("always drops at least minDrop groups regardless of dropFraction", () => {
		// Three user-response cycles, dropFraction=0.01 which would round to 0.
		// minDrop=1 forces at least one group to drop.
		const messages = [user("q1"), assistant("a1"), user("q2"), assistant("a2"), user("q3"), assistant("a3")];

		const result = dropOldestGroups(messages, 0.01);
		expect(result).toBeDefined();
		// Exactly one cycle dropped.
		expect(result).toHaveLength(4);
		expect(userText(result![0])).toBe("q2");
	});

	it("returns undefined when dropCount equals group count", () => {
		// 2 groups, dropFraction=1.0 -> drop both -> groups.length - dropCount = 0.
		const messages = [user("q1"), assistant("a1"), user("q2"), assistant("a2")];
		expect(dropOldestGroups(messages, 1.0)).toBeUndefined();
	});
});

// ============================================================================
// generateSummaryWithRetry
// ============================================================================

describe("generateSummaryWithRetry", () => {
	const stubModel = {} as Model;
	const stubOptions: SummaryOptions = {};
	const stubArgs = [stubModel, 1000, "fake-api-key", undefined, undefined, undefined, stubOptions] as const;

	// Matches Anthropic's error format in the OVERFLOW_PATTERNS list.
	const OVERFLOW_MSG = "prompt is too long: 500000 tokens > 200000 maximum";

	function makeMessages(cycleCount: number): AgentMessage[] {
		const out: AgentMessage[] = [];
		for (let i = 0; i < cycleCount; i++) {
			out.push(user(`q${i}`));
			out.push(assistant(`a${i}`));
		}
		return out;
	}

	it("returns the result immediately on first-attempt success (no retry)", async () => {
		let callCount = 0;
		const generator = async () => {
			callCount++;
			return "summary text";
		};

		const result = await generateSummaryWithRetry(makeMessages(5), ...stubArgs, generator);

		expect(result).toBe("summary text");
		expect(callCount).toBe(1);
	});

	it("rethrows non-overflow errors without any retry", async () => {
		let callCount = 0;
		const generator = async () => {
			callCount++;
			throw new Error("network disconnected");
		};

		await expect(generateSummaryWithRetry(makeMessages(5), ...stubArgs, generator)).rejects.toThrow(
			"network disconnected",
		);
		expect(callCount).toBe(1);
	});

	it("retries with truncated messages on overflow error", async () => {
		const seenLengths: number[] = [];
		let callCount = 0;
		const generator = async (messages: AgentMessage[]) => {
			callCount++;
			seenLengths.push(messages.length);
			if (callCount === 1) throw new Error(OVERFLOW_MSG);
			return "summary after retry";
		};

		const result = await generateSummaryWithRetry(makeMessages(10), ...stubArgs, generator);

		expect(result).toBe("summary after retry");
		expect(callCount).toBe(2);
		// First attempt saw full input; second saw strictly fewer messages.
		expect(seenLengths[0]).toBe(20); // 10 cycles × 2 messages
		expect(seenLengths[1]).toBeLessThan(seenLengths[0]);
	});

	it("drops a growing fraction across multiple retries", async () => {
		const seenLengths: number[] = [];
		const generator = async (messages: AgentMessage[]) => {
			seenLengths.push(messages.length);
			throw new Error(OVERFLOW_MSG);
		};

		await expect(generateSummaryWithRetry(makeMessages(10), ...stubArgs, generator)).rejects.toThrow();

		// MAX_SUMMARIZATION_RETRIES=2 -> 3 total attempts (0, 1, 2).
		expect(seenLengths).toHaveLength(3);
		// Each retry sees strictly fewer messages than the previous.
		expect(seenLengths[1]).toBeLessThan(seenLengths[0]);
		expect(seenLengths[2]).toBeLessThan(seenLengths[1]);
	});

	it("throws the LAST overflow error, not the first (more informative)", async () => {
		const errorMessages = [
			"prompt is too long: 500000 tokens > 200000 maximum",
			"prompt is too long: 300000 tokens > 200000 maximum",
			"prompt is too long: 210000 tokens > 200000 maximum",
		];
		let callCount = 0;
		const generator = async () => {
			const err = new Error(errorMessages[callCount]);
			callCount++;
			throw err;
		};

		await expect(generateSummaryWithRetry(makeMessages(10), ...stubArgs, generator)).rejects.toThrow(
			"prompt is too long: 210000 tokens > 200000 maximum",
		);
		expect(callCount).toBe(3);
	});

	it("gives up early when truncation cannot reduce message count further", async () => {
		const seenLengths: number[] = [];
		const generator = async (messages: AgentMessage[]) => {
			seenLengths.push(messages.length);
			throw new Error(OVERFLOW_MSG);
		};

		// 2 cycles -> 2 groups. dropFraction growth (0.2, 0.4) both round to
		// dropCount=1, so successive truncations produce the same length and the
		// `>=` guard should break the loop after the second call.
		await expect(generateSummaryWithRetry(makeMessages(2), ...stubArgs, generator)).rejects.toThrow(OVERFLOW_MSG);

		// First call with full input; second with 1 cycle dropped; third would
		// produce the same length so the retry is skipped.
		expect(seenLengths).toHaveLength(2);
		expect(seenLengths[0]).toBe(4); // 2 cycles × 2 messages
		expect(seenLengths[1]).toBe(2); // 1 cycle × 2 messages
	});

	it("gives up immediately when input is a single undroppable group", async () => {
		// Single-user tool loop: groupByUserTurn produces 1 group,
		// dropOldestGroups returns undefined, the retry cannot truncate.
		const messages = [user("do it"), assistant("a1"), toolResult("r"), assistant("a2")];
		let callCount = 0;
		const generator = async () => {
			callCount++;
			throw new Error(OVERFLOW_MSG);
		};

		await expect(generateSummaryWithRetry(messages, ...stubArgs, generator)).rejects.toThrow(OVERFLOW_MSG);
		// First attempt overflows, truncation returns undefined, loop breaks.
		expect(callCount).toBe(1);
	});
});
