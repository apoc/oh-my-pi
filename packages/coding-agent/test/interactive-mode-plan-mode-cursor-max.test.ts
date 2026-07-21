/**
 * Regression test for `InteractiveMode#restorePlanPreviousModel`'s "same model"
 * fast path silently dropping Cursor MAX mode on plan-mode exit.
 *
 * `#applyPlanModeModel` never touches `agent.#cursorMaxMode` when the plan role
 * resolves to the currently active model (the common case — no dedicated plan
 * model configured), so MAX mode can drift away from the pre-plan-mode value
 * during the plan-mode turn (e.g. a mid-plan-mode model-selector toggle, retry
 * fallback, or session-restore round-trip) without ever being corrected back on
 * exit unless `#restorePlanPreviousModel` explicitly restores it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { resolveLocalUrlToPath } from "../src/internal-urls";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { initTheme } from "../src/modes/theme/theme";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

const cursorModel: Model<"cursor-agent"> = buildModel({
	id: "gpt-5.5-extra-high",
	name: "GPT-5.5 Extra High",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://api2.cursor.sh",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 64_000,
	extendedContext: {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		baseContextWindow: 272_000,
		baseMaxTokens: 64_000,
	},
});

function createRegistry() {
	return {
		getAvailable: () => [cursorModel],
		getAll: () => [cursorModel],
		find: (provider: string, id: string) =>
			provider === cursorModel.provider && id === cursorModel.id ? cursorModel : undefined,
		getApiKey: async () => "cursor-key",
		hasConfiguredAuth: () => true,
		refreshSelectedModelMetadata: async (model: Model) => model,
		getApiKeyForProvider: async () => "cursor-key",
		syncExtensionSources: () => {},
		clearSourceRegistrations: () => {},
		registerProvider: () => {},
		getProviderBaseUrl: () => undefined,
		refreshRuntimeProviders: async () => {},
		authStorage: { onCredentialDisabled: () => () => {}, hasNonEnvCredential: () => false },
	} as never;
}

describe("InteractiveMode plan mode Cursor MAX round-trip", () => {
	let tempDir: string;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});
	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-cursor-max-"));
		await Settings.init({ inMemory: true, cwd: tempDir });
		const agent = new Agent({
			initialState: {
				model: cursorModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		agent.setCursorMaxMode(cursorModel, true);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, tempDir),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createRegistry(),
		});
		session.settings.setModelRole("default", "cursor/gpt-5.5-extra-high:max");
		session.settings.setModelRole("plan", "cursor/gpt-5.5-extra-high:max");
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		await session.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("restores the pre-plan-mode MAX flag on exit when the plan role resolves to the same model", async () => {
		expect(session.agent.getCursorMaxMode()).toBe(true);

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nNo model change needed.");

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()?.enabled).toBe(true);
		// Plan role resolves to the same model already active: #applyPlanModeModel's
		// same-model branch never touches maxMode, so it is still true here.
		expect(session.agent.getCursorMaxMode()).toBe(true);

		// Simulate MAX drifting away from the pre-plan-mode value during the plan
		// turn (e.g. a mid-plan-mode model-selector toggle or retry fallback) —
		// the underlying model is unchanged, only the flag flipped.
		session.agent.setCursorMaxMode(cursorModel, false);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and keep context");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(session.getPlanModeState()?.enabled).toBeFalsy();
		// The load-bearing assertion: exiting plan mode with the same underlying
		// model must restore the pre-plan-mode MAX flag, not leave whatever value
		// was active mid-plan-mode.
		expect(session.agent.getCursorMaxMode()).toBe(true);
	});

	it("does not resurrect MAX mode that was already off before entering plan mode", async () => {
		session.agent.setCursorMaxMode(cursorModel, false);
		expect(session.agent.getCursorMaxMode()).toBe(false);

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nNo model change needed.");

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()?.enabled).toBe(true);

		// MAX flips on mid-plan-mode (e.g. a stray toggle); exit must restore it
		// back to the pre-plan-mode value (off), not leave the mid-turn value.
		session.agent.setCursorMaxMode(cursorModel, true);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and keep context");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(session.agent.getCursorMaxMode()).toBe(false);
	});
});
