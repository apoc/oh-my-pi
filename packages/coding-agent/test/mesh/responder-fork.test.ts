import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { cfgFetchEnabled, cfgWebSearchEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, prompt, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import meshResponderMd from "../../src/prompts/agents/mesh-responder.md" with { type: "text" };

const MOCK_API_SOURCE = "mesh-responder-fork-test";
const AGENT_ID = "MeshAskFork";

function makeModelRegistry(authStorage: AuthStorage, modelsPath: string, model: MockModel): ModelRegistry {
	const registry = new ModelRegistry(authStorage, modelsPath);
	vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
	vi.spyOn(registry, "getAvailableForProviders").mockReturnValue([model]);
	vi.spyOn(registry, "getAll").mockReturnValue([model]);
	vi.spyOn(registry, "find").mockImplementation((provider, id) =>
		provider === model.provider && id === model.id ? model : undefined,
	);
	return registry;
}

beforeEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
});

describe("mesh ask responder fork", () => {
	it("spawns scouts that stay seance-confined and keep fetch and web search off", async () => {
		using tempDir = TempDir.createSync("@omp-mesh-responder-fork-");
		const cwd = path.join(tempDir.path(), "project");
		const sourceFile = path.join(tempDir.path(), "sessions", "host.jsonl");
		await fs.mkdir(cwd, { recursive: true });
		const timestamp = "2026-10-01T00:00:00.000Z";
		const sourceEntries = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "host-session", timestamp, cwd },
			{
				type: "message",
				id: "host-message",
				parentId: null,
				timestamp,
				message: { role: "user", content: "what are we doing?", timestamp: 1 },
			},
		];
		await Bun.write(sourceFile, `${sourceEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`);

		// The fork asks a scout and answers from its result; the scout answers in text.
		const mock = createMockModel({
			provider: "mock",
			id: "mesh-responder-fork",
			handler: context => {
				const fork = context.systemPrompt?.some(block => block.includes("mesh peer")) === true;
				if (!fork) return { content: [{ type: "text", text: "4*4 is 16" }] };
				if (context.messages.at(-1)?.role === "toolResult") return { content: [{ type: "text", text: "16" }] };
				return {
					content: [
						{
							type: "toolCall",
							id: "spawn",
							name: "task",
							arguments: { agent: "scout", name: "Probe", task: "Find the arithmetic." },
						},
					],
				};
			},
		});
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(mock.model.provider, "test-key");
		const modelRegistry = makeModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), mock.model);
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const agent = parseAgent("embedded:mesh-responder.md", prompt.render(meshResponderMd), "bundled");
		const modelOverride = [`${mock.model.provider}/${mock.model.id}`];
		const runSubprocess = executorModule.runSubprocess;
		const spawned: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
			spawned.push(options.id);
			return runSubprocess({ ...options, modelOverride });
		});

		try {
			const result = await runSubprocess({
				cwd,
				agent,
				task: "Answer the peer.",
				assignment: "What is 4*4?",
				index: 0,
				id: AGENT_ID,
				settings: Settings.isolated({
					"async.enabled": false,
					"task.batch": false,
					"task.agentIdleTtlMs": 0,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
				}),
				modelRegistry,
				authStorage,
				getApiKey: async () => "test-key",
				modelOverride,
				preparedSession: {
					fork: { sourceFile, hostRestrictions: { "fetch.enabled": false, "web_search.enabled": false } },
					promptSuffix: () => "",
				},
				artifactsDir: path.join(tempDir.path(), "responders"),
				restrictToolNames: true,
				structured: false,
				enableIrc: false,
				enableLsp: false,
				enableMCP: false,
				parentAgentId: "Main",
				eventBus: new EventBus(),
			});
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("16");

			const registry = AgentRegistry.global();
			const fork = registry.get(AGENT_ID)?.session;
			const [scoutId] = spawned;
			const scout = scoutId ? registry.get(scoutId)?.session : undefined;
			if (!fork || !scout || !isLocalAgentSession(fork) || !isLocalAgentSession(scout)) {
				throw new Error("Expected the fork and its scout to stay alive on this thread");
			}
			// The scout reads history://, agent:// and artifact:// only within the fork's source.
			const confinedTo = fork.sessionManager.getSeanceSourceArtifactsDir();
			expect(confinedTo).toBeString();
			expect(scout.sessionManager.getSeanceSourceArtifactsDir()).toBe(confinedTo);
			expect(cfgFetchEnabled.get(scout.settings)).toBe(false);
			expect(cfgWebSearchEnabled.get(scout.settings)).toBe(false);
			expect(scout.getEnabledToolNames()).not.toContain("web_search");
		} finally {
			for (const id of [AGENT_ID, ...spawned]) {
				await AgentLifecycleManager.global()
					.release(id)
					.catch(() => false);
			}
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});
});
