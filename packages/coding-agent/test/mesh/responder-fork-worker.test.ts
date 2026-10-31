/**
 * A mesh `ask` responder fork placed on a pooled worker thread (main's pool moves subagent runs
 * there under load): its host restrictions must still bind the fork and every scout it spawns.
 * The scripted OpenAI-compatible server is reached by the worker through `models.yml`, so the
 * assertions read what each model actually saw: the tools offered and the tool results returned.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, prompt, removeWithRetries } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import meshResponderMd from "../../src/prompts/agents/mesh-responder.md" with { type: "text" };
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentStorage } from "../../src/session/agent-storage";
import type { AuthStorage } from "../../src/session/auth-storage";
import { CURRENT_SESSION_VERSION } from "../../src/session/session-entries";
import { parseAgent } from "../../src/task/agents";
import { runSubprocess } from "../../src/task/executor";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "../../src/thread/subagent-worker";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const MODEL = "fake/fake-model";
const FORK_MARKER = "You answer questions from a mesh peer";
const TEST_TIMEOUT_MS = 120_000;

interface ChatMessage {
	role: string;
	content?: unknown;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

function isChatMessage(value: unknown): value is ChatMessage {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "role") === "string";
}

function toolNames(body: unknown): string[] {
	const tools: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "tools") : undefined;
	if (!Array.isArray(tools)) return [];
	return tools.map(tool => String(Reflect.get(Reflect.get(tool, "function") ?? {}, "name")));
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

function chunks(reply: Reply): string {
	const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
	const delta =
		"text" in reply
			? { role: "assistant", content: reply.text }
			: {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `call_${reply.tool}`,
							type: "function",
							function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
						},
					],
				};
	const frames = [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }] },
		{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	return `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

/**
 * The fork reads a URL on this server, then spawns a scout, then answers `16`; the scout reads
 * another URL, then answers. Records every non-model path hit and what each agent was offered
 * and given back.
 */
class FakeModelServer {
	readonly #server: Bun.Server<undefined>;
	readonly leakHits: string[] = [];
	readonly forkTools = new Set<string>();
	readonly scoutTools = new Set<string>();
	readonly forkToolResults: string[] = [];
	readonly scoutToolResults: string[] = [];

	constructor() {
		this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#fetch(request) });
	}

	url(pathname: string): string {
		return `http://127.0.0.1:${this.#server.port}${pathname}`;
	}

	async writeModelsYml(agentDir: string): Promise<string> {
		const file = path.join(agentDir, "models.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  fake:",
				`    baseUrl: ${this.url("/v1")}`,
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        name: Fake Model",
				"        reasoning: false",
				"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
				"",
			].join("\n"),
		);
		return file;
	}

	stop(): void {
		this.#server.stop(true);
	}

	async #fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
		}
		if (!url.pathname.endsWith("/chat/completions")) {
			this.leakHits.push(url.pathname);
			return new Response("leaked", { status: 200 });
		}
		const body: unknown = await request.json();
		const rawMessages: unknown =
			typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
		const messages = Array.isArray(rawMessages) ? rawMessages.filter(isChatMessage) : [];
		const isFork = messages.some(message => messageText(message.content).includes(FORK_MARKER));
		const toolMessages = messages.filter(message => message.role === "tool");
		const last = messages.at(-1);
		for (const name of toolNames(body)) (isFork ? this.forkTools : this.scoutTools).add(name);
		if (last?.role === "tool")
			(isFork ? this.forkToolResults : this.scoutToolResults).push(messageText(last.content));

		let reply: Reply;
		if (isFork) {
			if (toolMessages.length === 0) reply = { tool: "read", args: { path: this.url("/fork-leak") } };
			else if (toolMessages.length === 1)
				reply = { tool: "task", args: { agent: "scout", name: "Probe", task: "Find the arithmetic." } };
			else reply = { text: "16" };
		} else {
			reply =
				toolMessages.length === 0
					? { tool: "read", args: { path: this.url("/scout-leak") } }
					: { text: "4*4 is 16" };
		}
		return new Response(chunks(reply), { headers: { "content-type": "text/event-stream" } });
	}
}

let root: string;
let savedEnv: Record<string, string | undefined> = {};
let server: FakeModelServer;
let pool: SubagentWorkerPool;
let authStorage: AuthStorage;

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mesh-responder-worker-"));
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, ".omp", "agent"), { recursive: true });
	// Workers read these at start-up, so set them before the pool spawns any.
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", path.join(home, ".omp", "agent"));
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	server = new FakeModelServer();
	authStorage = createInMemoryAuthStorage();
	// Every run goes to a worker, as under load.
	pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 600_000,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000 },
	});
	setSubagentWorkerPoolForTests(pool);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	setSubagentWorkerPoolForTests(undefined);
	pool.dispose();
	server.stop();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	authStorage.close();
	AgentStorage.close();
	closeModelCache();
	for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

describe("mesh ask responder fork on a worker thread", () => {
	it(
		"keeps URL reads and web search off for the fork and the scout it spawns",
		async () => {
			const cwd = path.join(root, "project");
			const sourceFile = path.join(root, "sessions", "host.jsonl");
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
			const modelRegistry = new ModelRegistry(
				authStorage,
				await server.writeModelsYml(process.env.PI_CODING_AGENT_DIR!),
			);
			await modelRegistry.refresh();
			const agent = parseAgent("embedded:mesh-responder.md", prompt.render(meshResponderMd), "bundled");

			const result = await runSubprocess({
				cwd,
				agent,
				task: "Answer the peer.",
				assignment: "What is 4*4?",
				index: 0,
				id: "MeshAskFork",
				settings: Settings.isolated({
					"async.enabled": false,
					"task.batch": false,
					"task.agentIdleTtlMs": 0,
					"task.completionProbe": false,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"advisor.enabled": false,
					modelRoles: { default: MODEL, smol: MODEL },
				}),
				modelRegistry,
				authStorage,
				modelOverride: MODEL,
				preparedSession: {
					fork: { sourceFile, hostRestrictions: { "fetch.enabled": false, "web_search.enabled": false } },
					promptSuffix: () => "",
				},
				artifactsDir: path.join(root, "responders"),
				restrictToolNames: true,
				structured: false,
				enableIrc: false,
				enableLsp: false,
				enableMCP: false,
				parentAgentId: "Main",
				eventBus: new EventBus(),
			});

			expect(result.error).toBeUndefined();
			expect(result.output).toBe("16");
			// The run really was homed on the worker.
			expect(AgentRegistry.global().get("MeshAskFork")?.session).toBeInstanceOf(RemoteAgentSession);
			expect(server.leakHits).toEqual([]);
			expect(server.forkToolResults[0]).toContain("URL reads are disabled by settings.");
			expect(server.scoutToolResults[0]).toContain("URL reads are disabled by settings.");
			expect(server.scoutTools.has("read")).toBe(true);
			expect(server.scoutTools.has("web_search")).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);
});
