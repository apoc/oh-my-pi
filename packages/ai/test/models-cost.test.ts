import { describe, expect, it } from "bun:test";
import { calculateCost, getBundledModel } from "../src/models";
import type { Usage } from "../src/types";

describe("calculateCost", () => {
	it("keeps token-based calculation for GitHub Copilot models", () => {
		const model = {
			...getBundledModel("github-copilot", "gpt-4o"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 123,
				output: 456,
				cacheRead: 789,
				cacheWrite: 321,
				total: 1689,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("keeps token-based calculation for non-Copilot providers", () => {
		const model = {
			...getBundledModel("openai", "gpt-4o-mini"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	describe("long context pricing", () => {
		const rawModel = getBundledModel("anthropic", "claude-opus-4-6");
		const model = rawModel.longContextPricing
			? rawModel
			: {
					...rawModel,
					longContextPricing: {
						inputThreshold: 200_000,
						// Anthropic Opus 4.6 long-context prices (from models.dev / official pricing)
						input: 10,
						output: 37.5,
						cacheRead: 1,
						cacheWrite: 12.5,
					},
				};

		function makeUsage(tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>): Usage {
			return {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				...tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}

		it("applies standard rates when total input is below threshold", () => {
			const usage = makeUsage({ input: 50_000, output: 10_000, cacheRead: 100_000, cacheWrite: 40_000 });
			const cost = calculateCost(model, usage);

			const { input: ir, output: or, cacheRead: cr, cacheWrite: cw } = model.cost;
			expect(cost.input).toBeCloseTo((ir / 1_000_000) * 50_000);
			expect(cost.output).toBeCloseTo((or / 1_000_000) * 10_000);
			expect(cost.cacheRead).toBeCloseTo((cr / 1_000_000) * 100_000);
			expect(cost.cacheWrite).toBeCloseTo((cw / 1_000_000) * 40_000);
			expect(cost.total).toBeCloseTo(cost.input + cost.output + cost.cacheRead + cost.cacheWrite);
		});

		it("applies long-context rates when total input (input + cacheRead + cacheWrite) exceeds threshold", () => {
			// input(100K) + cacheRead(100K) + cacheWrite(50K) = 250K > 200K threshold; all three count per Anthropic docs
			const usage = makeUsage({ input: 100_000, output: 20_000, cacheRead: 100_000, cacheWrite: 50_000 });
			const cost = calculateCost(model, usage);

			const lc = model.longContextPricing!;
			expect(cost.input).toBeCloseTo((lc.input / 1_000_000) * 100_000);
			expect(cost.output).toBeCloseTo((lc.output / 1_000_000) * 20_000);
			expect(cost.cacheRead).toBeCloseTo((lc.cacheRead! / 1_000_000) * 100_000);
			expect(cost.cacheWrite).toBeCloseTo((lc.cacheWrite! / 1_000_000) * 50_000);
			expect(cost.total).toBeCloseTo(cost.input + cost.output + cost.cacheRead + cost.cacheWrite);
		});

		it("uses standard rates when model has no longContextPricing", () => {
			const modelWithout = { ...model, longContextPricing: undefined };
			const usage = makeUsage({ input: 300_000, output: 10_000 });
			const cost = calculateCost(modelWithout, usage);

			const { input: ir, output: or } = model.cost;
			expect(cost.input).toBeCloseTo((ir / 1_000_000) * 300_000);
			expect(cost.output).toBeCloseTo((or / 1_000_000) * 10_000);
			expect(cost.total).toBeCloseTo(cost.input + cost.output);
		});

		it("applies standard rates when input + cacheRead + cacheWrite equals threshold exactly", () => {
			// input(100K) + cacheRead(60K) + cacheWrite(40K) = 200K = threshold; NOT > threshold, so standard rates
			const usage = makeUsage({ input: 100_000, output: 10_000, cacheRead: 60_000, cacheWrite: 40_000 });
			const cost = calculateCost(model, usage);

			const { input: ir, output: or, cacheRead: cr, cacheWrite: cw } = model.cost;
			expect(cost.input).toBeCloseTo((ir / 1_000_000) * 100_000);
			expect(cost.output).toBeCloseTo((or / 1_000_000) * 10_000);
			expect(cost.cacheRead).toBeCloseTo((cr / 1_000_000) * 60_000);
			expect(cost.cacheWrite).toBeCloseTo((cw / 1_000_000) * 40_000);
			expect(cost.total).toBeCloseTo(cost.input + cost.output + cost.cacheRead + cost.cacheWrite);
		});
	});
});
