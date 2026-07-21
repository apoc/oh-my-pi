import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
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

const sonnetModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-3-5-sonnet-20241022",
	name: "Claude 3.5 Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
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
		clearSuppressedSelector: () => {},
		registerProvider: () => {},
		getProviderBaseUrl: () => undefined,
		refreshRuntimeProviders: async () => {},
		authStorage: { onCredentialDisabled: () => () => {}, hasNonEnvCredential: () => false },
	} as never;
}

async function createTargetSession(tempDir: string, selector: string): Promise<string> {
	const manager = SessionManager.create(tempDir, tempDir);
	manager.appendModelChange(selector);
	manager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
	await manager.rewriteEntries();
	const file = manager.getSessionFile();
	await manager.close();
	if (!file) throw new Error("Expected target session file");
	return file;
}

async function createTargetSessionWithHistory(tempDir: string, selectors: readonly string[]): Promise<string> {
	const manager = SessionManager.create(tempDir, tempDir);
	for (const selector of selectors) {
		manager.appendModelChange(selector);
	}
	manager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
	await manager.rewriteEntries();
	const file = manager.getSessionFile();
	await manager.close();
	if (!file) throw new Error("Expected target session file");
	return file;
}

/** Both `cursorModel` and `sonnetModel` genuinely available (unlike
 *  `createCursorHiddenFromAvailableRegistry`, which hides cursor from
 *  `getAvailable`) — for resume scenarios that land on either provider. */
function createBothAvailableRegistry() {
	return {
		getAvailable: () => [cursorModel, sonnetModel],
		getAll: () => [cursorModel, sonnetModel],
		find: (provider: string, id: string) =>
			[cursorModel, sonnetModel].find(model => model.provider === provider && model.id === id),
		getApiKey: async () => "model-key",
		hasConfiguredAuth: () => true,
		refreshSelectedModelMetadata: async (model: Model) => model,
		getApiKeyForProvider: async () => "model-key",
		syncExtensionSources: () => {},
		clearSourceRegistrations: () => {},
		clearSuppressedSelector: () => {},
		registerProvider: () => {},
		getProviderBaseUrl: () => undefined,
		refreshRuntimeProviders: async () => {},
		authStorage: { onCredentialDisabled: () => () => {}, hasNonEnvCredential: () => false },
	} as never;
}

function createCursorHiddenFromAvailableRegistry() {
	return {
		getAvailable: () => [sonnetModel],
		getAll: () => [sonnetModel, cursorModel],
		find: (provider: string, id: string) =>
			[sonnetModel, cursorModel].find(model => model.provider === provider && model.id === id),
		getApiKey: async () => "model-key",
		hasConfiguredAuth: () => true,
		refreshSelectedModelMetadata: async (model: Model) => model,
		getApiKeyForProvider: async () => "model-key",
		syncExtensionSources: () => {},
		clearSourceRegistrations: () => {},
		clearSuppressedSelector: () => {},
		registerProvider: () => {},
		getProviderBaseUrl: () => undefined,
		refreshRuntimeProviders: async () => {},
		authStorage: { onCredentialDisabled: () => () => {}, hasNonEnvCredential: () => false },
	} as never;
}

describe("AgentSession Cursor MAX resume", () => {
	const sessions: AgentSession[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSessionWithMaxActive(
		tempDir: string,
		registry: unknown = createRegistry(),
	): Promise<AgentSession> {
		const agent = new Agent({
			initialState: {
				model: cursorModel,
				systemPrompt: [],
				tools: [],
			},
		});
		agent.setCursorMaxMode(cursorModel, true);

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, tempDir),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry as never,
		});
		sessions.push(session);
		return session;
	}

	it("clears MAX and restores the base context window for a plain saved Cursor selector", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-resume-"));
		tempDirs.push(tempDir);
		const targetFile = await createTargetSession(tempDir, "cursor/gpt-5.5-extra-high");
		const session = await createSessionWithMaxActive(tempDir);

		await expect(session.switchSession(targetFile)).resolves.toBe(true);

		expect(session.agent.getCursorMaxMode()).toBe(false);
		expect(session.model?.contextWindow).toBe(272_000);
		expect(session.model?.maxTokens).toBe(64_000);
	});

	it("clears MAX for a plain canonical saved Cursor selector", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-resume-"));
		tempDirs.push(tempDir);
		const targetFile = await createTargetSession(tempDir, "gpt-5.5-extra-high");
		const session = await createSessionWithMaxActive(tempDir);

		await expect(session.switchSession(targetFile)).resolves.toBe(true);

		expect(session.agent.getCursorMaxMode()).toBe(false);
		expect(session.model?.provider).toBe("cursor");
		expect(session.model?.id).toBe("gpt-5.5-extra-high");
		expect(session.model?.contextWindow).toBe(272_000);
	});

	it("restores MAX and the extended context window for a saved Cursor :max selector", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-resume-"));
		tempDirs.push(tempDir);
		const targetFile = await createTargetSession(tempDir, "cursor/gpt-5.5-extra-high:max");
		const session = await createSessionWithMaxActive(tempDir);
		session.agent.setCursorMaxMode(cursorModel, false);

		await expect(session.switchSession(targetFile)).resolves.toBe(true);

		expect(session.agent.getCursorMaxMode()).toBe(true);
		expect(session.model?.contextWindow).toBe(1_000_000);
		expect(session.model?.maxTokens).toBe(128_000);
	});

	it("restores MAX for a canonical saved Cursor selector", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-resume-"));
		tempDirs.push(tempDir);
		const targetFile = await createTargetSession(tempDir, "gpt-5.5-extra-high:max");
		const session = await createSessionWithMaxActive(tempDir);
		session.agent.setCursorMaxMode(cursorModel, false);

		await expect(session.switchSession(targetFile)).resolves.toBe(true);

		expect(session.agent.getCursorMaxMode()).toBe(true);
		expect(session.model?.provider).toBe("cursor");
		expect(session.model?.id).toBe("gpt-5.5-extra-high");
		expect(session.model?.contextWindow).toBe(1_000_000);
	});

	it("restores MAX context for a canonical selector during createAgentSession startup", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-startup-"));
		tempDirs.push(tempDir);
		const targetFile = await createTargetSession(tempDir, "gpt-5.5-extra-high:max");
		const sessionManager = await SessionManager.open(targetFile);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createRegistry(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);

		expect(session.agent.getCursorMaxMode()).toBe(true);
		expect(session.model?.contextWindow).toBe(1_000_000);
		expect(session.model?.maxTokens).toBe(128_000);
	});

	it("uses a canonical Cursor default hidden from getAvailable instead of falling back to Sonnet", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-startup-"));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", "gpt-5.5-extra-high:max");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings,
			modelRegistry: createCursorHiddenFromAvailableRegistry(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);

		expect(session.model?.provider).toBe("cursor");
		expect(session.model?.id).toBe("gpt-5.5-extra-high");
		expect(session.agent.getCursorMaxMode()).toBe(true);
		expect(session.model?.contextWindow).toBe(1_000_000);
	});

	it("preserves the current MAX flag when setModelTemporary omits maxMode", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-resume-"));
		tempDirs.push(tempDir);
		const session = await createSessionWithMaxActive(tempDir);

		expect(session.agent.getCursorMaxMode()).toBe(true);
		expect(session.model?.contextWindow).toBe(1_000_000);

		await session.setModelTemporary(cursorModel);

		expect(session.agent.getCursorMaxMode()).toBe(true);
		expect(session.model?.contextWindow).toBe(1_000_000);
	});

	it("persists MAX in model-change entries for later resume", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-resume-"));
		tempDirs.push(tempDir);
		const session = await createSessionWithMaxActive(tempDir);
		session.agent.setCursorMaxMode(cursorModel, false);

		await session.setModel(cursorModel, "default", { maxMode: true });

		expect(session.buildDisplaySessionContext().models.default).toBe("cursor/gpt-5.5-extra-high:max");
		expect(session.agent.getCursorMaxMode()).toBe(true);
		expect(session.model?.contextWindow).toBe(1_000_000);

		await session.setModel(cursorModel, "default", { maxMode: false });

		expect(session.buildDisplaySessionContext().models.default).toBe("cursor/gpt-5.5-extra-high");
		expect(session.agent.getCursorMaxMode()).toBe(false);
		expect(session.model?.contextWindow).toBe(272_000);
	});

	it("clears MAX and switches away when resuming into a saved non-Cursor selector", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-resume-"));
		tempDirs.push(tempDir);
		const targetFile = await createTargetSession(tempDir, "anthropic/claude-3-5-sonnet-20241022");
		const session = await createSessionWithMaxActive(tempDir, createBothAvailableRegistry());

		await expect(session.switchSession(targetFile)).resolves.toBe(true);

		expect(session.model?.provider).toBe("anthropic");
		expect(session.model?.id).toBe("claude-3-5-sonnet-20241022");
		// No `:max`-suffix artifact carries over from the pre-resume Cursor MAX
		// state onto the resumed non-Cursor model.
		expect(session.agent.getCursorMaxMode()).toBe(false);
	});

	it("resumes into the LATEST model-change entry, not the first, after a mid-session role switch", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-max-resume-"));
		tempDirs.push(tempDir);
		// The target session first switched to Cursor MAX, then switched away to
		// a plain non-Cursor model — resume must reflect the LATEST entry, not
		// the first, even though the first entry enabled MAX.
		const targetFile = await createTargetSessionWithHistory(tempDir, [
			"cursor/gpt-5.5-extra-high:max",
			"anthropic/claude-3-5-sonnet-20241022",
		]);
		const session = await createSessionWithMaxActive(tempDir, createBothAvailableRegistry());

		await expect(session.switchSession(targetFile)).resolves.toBe(true);

		expect(session.model?.provider).toBe("anthropic");
		expect(session.model?.id).toBe("claude-3-5-sonnet-20241022");
		expect(session.agent.getCursorMaxMode()).toBe(false);
	});
});
