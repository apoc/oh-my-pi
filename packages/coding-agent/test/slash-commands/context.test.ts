import { describe, expect, it } from "bun:test";
import { formatTokens, parseContextSize } from "../../src/slash-commands/builtin-registry";

describe("/context slash command utils", () => {
	describe("parseContextSize", () => {
		it("parses raw numbers", () => {
			expect(parseContextSize("12345")).toBe(12345);
			expect(parseContextSize("200000")).toBe(200000);
			expect(parseContextSize("1000000")).toBe(1000000);
		});

		it("parses 'k' suffix (thousands)", () => {
			expect(parseContextSize("5k")).toBe(5000);
			expect(parseContextSize("128k")).toBe(128000);
			expect(parseContextSize("200k")).toBe(200000);
			expect(parseContextSize("200.5k")).toBe(200500);
		});

		it("parses 'm' suffix (millions)", () => {
			expect(parseContextSize("1m")).toBe(1000000);
			expect(parseContextSize("2m")).toBe(2000000);
			expect(parseContextSize("1.5m")).toBe(1500000);
			expect(parseContextSize("0.5m")).toBe(500000);
		});

		it("rejects invalid formats", () => {
			expect(parseContextSize("")).toBeNull();
			expect(parseContextSize("abc")).toBeNull();
			expect(parseContextSize("123kb")).toBeNull();
			expect(parseContextSize("-5k")).toBeNull();
			expect(parseContextSize("0")).toBeNull();
			expect(parseContextSize("1.2.3k")).toBeNull();
		});
	});

	describe("formatTokens", () => {
		it("formats exact millions", () => {
			expect(formatTokens(1_000_000)).toBe("1M");
			expect(formatTokens(2_000_000)).toBe("2M");
		});

		it("formats exact thousands", () => {
			expect(formatTokens(200_000)).toBe("200K");
			expect(formatTokens(128_000)).toBe("128K");
			expect(formatTokens(5_000)).toBe("5K");
			expect(formatTokens(1_500_000)).toBe("1.5M");
		});

		it("formats exact tokens below 1K", () => {
			expect(formatTokens(999)).toBe("999");
			expect(formatTokens(100)).toBe("100");
			expect(formatTokens(0)).toBe("0");
		});

		it("rounds fractional thousands", () => {
			expect(formatTokens(200_500)).toBe("201K");
			expect(formatTokens(128_100)).toBe("128K");
		});

		it("formats fractional millions", () => {
			expect(formatTokens(1_200_000)).toBe("1.2M");
			expect(formatTokens(2_500_000)).toBe("2.5M");
		});
	});
});
