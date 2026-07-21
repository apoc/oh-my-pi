import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/**
 * `resolveDefaultRoleSpec` (sdk.ts) falls back to `modelRegistry.getAll()` — which
 * does NOT filter `disabledProviders` — instead of the availability-filtered
 * `allowedModels` whenever `enabledModels` is unset. Before the fix this dropped
 * `disabledProviders` enforcement entirely for that (common) case: a provider a
 * user explicitly disabled could still be silently selected via a configured
 * `modelRoles.default` pointing straight at it, as long as credentials for it
 * still existed in authStorage.
 */
function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

describe("default-role resolution respects disabledProviders when enabledModels is unset", () => {
	let testDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		resetSettingsForTest();
		testDir = path.join(os.tmpdir(), `pi-disabled-providers-default-${Snowflake.next()}`);
		agentDir = path.join(testDir, "agent");
		cwd = path.join(testDir, "private", "sub");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		// Prevent leaked developer env keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …)
		// from making non-copilot providers appear available in authStorage.hasAuth().
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// AgentStorage caches a bun:sqlite Database keyed by agentDir (touched by
		// Settings' legacy-settings migration); resetSettingsForTest() alone
		// doesn't close it, so the handle can still be open when removing testDir
		// on Windows.
		AgentStorage.resetInstance();
		resetSettingsForTest();
		if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
	});

	test("does not select a disabled provider's model even with a matching modelRoles.default and stored credentials", async () => {
		const privatePath = path.join(testDir, "private");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				// Also disable the keyless implicit local providers: ollama/llama.cpp/lm-studio
				// bypass the getEnvApiKey mock, so a dev machine running one of those servers
				// could otherwise surface a fallback model and break `session.model` toBeUndefined.
				disabledProviders: [
					{ path: privatePath, providers: ["github-copilot", "ollama", "llama.cpp", "lm-studio"] },
				],
				modelRoles: { default: "github-copilot/gpt-5.5" },
			}),
		);

		const settings = await Settings.init({ cwd, agentDir });
		// Sanity-check: enabledModels is unset (the fallback branch under test),
		// disabledProviders is the only scope in play.
		expect(settings.get("enabledModels")).toEqual([]);
		expect(settings.get("disabledProviders")).toEqual(["github-copilot", "ollama", "llama.cpp", "lm-studio"]);

		const authStorage = await AuthStorage.create(path.join(testDir, "auth.db"));
		// github-copilot has stored credentials — only `disabledProviders` should
		// keep it out of the default-role resolution.
		authStorage.setRuntimeApiKey("github-copilot", "test-github-copilot-key");

		const modelRegistry = new ModelRegistry(authStorage, path.join(testDir, "models.yml"));

		try {
			const { session, modelFallbackMessage } = await createAgentSession({
				cwd,
				agentDir,
				authStorage,
				modelRegistry,
				settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				workspaceTree: emptyWorkspaceTree(cwd),
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			try {
				// Regression: the disabled provider must never be selected, even
				// though it is the literal target of modelRoles.default and has
				// stored credentials.
				expect(session.model?.provider).not.toBe("github-copilot");
				// No other provider has credentials (env keys are mocked out, only
				// github-copilot has a runtime key — which disabledProviders removes).
				expect(session.model).toBeUndefined();
				expect(modelFallbackMessage).toBeDefined();
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});
});
