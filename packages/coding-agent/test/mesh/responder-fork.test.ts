import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

/** The `# Internal URLs` entries that advertise `memory://`, from a request's system prompt blocks. */
function memoryUrlLines(systemPrompt: readonly string[] | undefined): string[] {
	const lines = (systemPrompt ?? []).join("\n").split("\n");
	const start = lines.indexOf("# Internal URLs");
	if (start < 0) throw new Error("System prompt has no # Internal URLs section");
	const end = lines.findIndex((line, index) => index > start && line.trim() === "");
	return lines.slice(start, end < 0 ? lines.length : end).filter(line => line.startsWith("- memory://"));
}

describe("mesh ask responder fork", () => {
	it("spawns scouts that stay confined to the fork source and keep fetch and web search off", async () => {
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
				fork: { sourceFile, hostRestrictions: { "fetch.enabled": false, "web_search.enabled": false } },
				artifactsDir: path.join(tempDir.path(), "responders"),
				restrictToolNames: true,
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
			// The scout reads history://, agent:// and local:// spills only within the fork's source.
			const confinedTo = fork.sessionManager.getForkSourceArtifactsDir();
			expect(confinedTo).toBeString();
			expect(scout.sessionManager.getForkSourceArtifactsDir()).toBe(confinedTo);
			expect(cfgFetchEnabled.get(scout.settings)).toBe(false);
			expect(cfgWebSearchEnabled.get(scout.settings)).toBe(false);
			expect(scout.getEnabledToolNames()).not.toContain("web_search");

			// The scout publishes its output into the fork's own artifacts dir, which agent:// reads
			// for the fork's real tool session.
			const forkToolSession = fork.toolSession;
			if (!forkToolSession) throw new Error("Expected the fork to expose its tool session");
			const published = await InternalUrlRouter.instance().resolve(
				`agent://${scoutId}`,
				sessionResolveContext(forkToolSession),
			);
			expect(published.content).toContain("4*4 is 16");
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

	// A confined fork is normally a restricted session, which has no memory backend at all; this
	// session is deliberately unrestricted so the only thing keeping `memory://` out of its prompt
	// is the SDK handing `confined` to the prompt builder from the session's fork source.
	it("builds the system prompt of a confined session fork without memory://, unlike an ordinary session", async () => {
		using tempDir = TempDir.createSync("@omp-mesh-confined-prompt-");
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

		const mock = createMockModel({ provider: "mock", id: "mesh-confined-prompt" });
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(mock.model.provider, "test-key");
		const modelRegistry = makeModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), mock.model);
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const sessions: Array<{ dispose(): Promise<void> }> = [];
		const systemPromptOf = async (sessionManager: SessionManager): Promise<string[]> => {
			const { session } = await createAgentSession({
				cwd,
				agentDir: path.join(tempDir.path(), "agent"),
				authStorage,
				modelRegistry,
				model: mock.model,
				settings: Settings.isolated({
					"memory.backend": "local",
					"async.enabled": false,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
				}),
				sessionManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				enableMCP: false,
				enableLsp: false,
			});
			sessions.push(session);
			return session.systemPrompt;
		};

		try {
			const confined = await SessionManager.forkFrom(
				sourceFile,
				cwd,
				path.join(tempDir.path(), "forks"),
				undefined,
				{ confined: true },
			);
			expect(confined.getForkSource()).toBeTruthy();
			expect(memoryUrlLines(await systemPromptOf(confined))).toEqual([]);

			const ordinary = SessionManager.inMemory(cwd);
			expect(ordinary.getForkSource()).toBeFalsy();
			expect(memoryUrlLines(await systemPromptOf(ordinary))).toEqual(["- memory://root: project-memory summary."]);
		} finally {
			for (const session of sessions) await session.dispose();
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});
});
