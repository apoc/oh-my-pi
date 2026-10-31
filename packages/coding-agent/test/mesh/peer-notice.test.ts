import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { MeshEngine, MeshPeerView } from "../../src/mesh/engine";
import { MESH_PEERS_NOTICE_TYPE } from "../../src/mesh/peer-notice";
import { type MeshRuntime, setMeshRuntime } from "../../src/mesh/runtime";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

/** A peer whose session already has a name and a summary, so it is announced; `null` leaves either out. */
function peer(
	instanceId: string,
	displayName: string,
	sessionName: string | null = "work",
	summary: string | null = "Working on the task.",
): MeshPeerView {
	return {
		instanceId,
		endpoint: { kind: "local" },
		source: "local",
		state: "online",
		lastSeen: Date.now(),
		hidden: false,
		blocked: false,
		snapshot: {
			instanceId,
			displayName,
			host: "box",
			pid: 1,
			ompVersion: "0.0.0",
			protocol: 1,
			sessionId: null,
			sessionName,
			summary: summary === null ? null : { text: summary, updatedAt: 0 },
			cwd: "/work",
			repo: null,
			model: null,
			busy: false,
			agents: [],
			startedAt: 0,
		},
	};
}

function requestText(context: Context): string {
	return context.messages
		.flatMap(message =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])),
		)
		.join("\n");
}

function noticeDetails(session: AgentSession): unknown[] {
	return session.agent.state.messages.flatMap(message =>
		message.role === "custom" && message.customType === MESH_PEERS_NOTICE_TYPE ? [message.details] : [],
	);
}

describe("mesh peer notices", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	let peers: MeshPeerView[] = [];

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-mesh-peer-notice-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		setMeshRuntime(undefined);
		peers = [];
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(dir)) removeSyncWithRetries(dir);
	});

	/** A session bound to a fake mesh whose engine started `startedAt` (long enough ago for discovery by default). */
	async function boundSession(identity = { startedAt: 0 }): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "archive.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		const engine = { peers: () => peers } as unknown as MeshEngine;
		setMeshRuntime({ engine, session, identity } as unknown as MeshRuntime);
		return session;
	}

	it("sends the roster with the first prompt, then only appearances and departures", async () => {
		const session = await boundSession();
		const mock = createMockModel({ handler: { content: ["ok"] } });
		session.agent.streamFn = mock.stream;

		peers = [peer("c0ffee", "Carol", "auth refactor")];
		await session.prompt("first");
		peers = [peer("b0b000", "Bob")];
		await session.prompt("second");
		await session.prompt("third");
		// Stopping the mesh is not every agent leaving.
		setMeshRuntime(undefined);
		await session.prompt("fourth");

		const [first, second] = mock.calls.map(call => requestText(call.context));
		expect(first).toContain("Carol (c0ffee)");
		expect(first).toContain("auth refactor");
		expect(second).toContain("Bob (b0b000)");
		expect(second).toContain("Left the mesh");
		expect(second).toContain("Carol (c0ffee)");
		expect(noticeDetails(session)).toEqual([
			{ added: [{ id: "c0ffee", name: "Carol" }], removed: [] },
			{ added: [{ id: "b0b000", name: "Bob" }], removed: ["c0ffee"] },
		]);
	});

	it("tells an agent alone on the mesh, so later arrivals are announced mid-run", async () => {
		const session = await boundSession();
		const mock = createMockModel({
			responses: [
				{ content: ["alone"] },
				() => {
					peers = [peer("d00d00", "Dave", "docs")];
					return { content: [{ type: "toolCall", name: "read", arguments: { path: "missing.txt" } }] };
				},
				{ content: ["done"] },
			],
		});
		session.agent.streamFn = mock.stream;

		await session.prompt("first");
		await session.prompt("second");

		expect(requestText(mock.calls[0]!.context)).toContain("No other omp agents to report on the mesh");
		// The arrival lands after the tool batch, before the next model call of the same run.
		const afterTool = requestText(mock.calls[2]!.context);
		expect(afterTool).toContain("Dave (d00d00)");
		expect(afterTool).toContain("no reply needed");
		expect(noticeDetails(session)).toEqual([
			{ added: [], removed: [] },
			{ added: [{ id: "d00d00", name: "Dave" }], removed: [] },
		]);
	});

	it("never extends a finished turn to announce a peer", async () => {
		const session = await boundSession();
		const mock = createMockModel({
			responses: [
				{ content: ["first"] },
				() => {
					peers = [peer("e0e0e0", "Eve")];
					return { content: ["second"] };
				},
			],
			handler: { content: ["third"] },
		});
		session.agent.streamFn = mock.stream;

		await session.prompt("first");
		await session.prompt("second");
		expect(mock.calls).toHaveLength(2);
		await session.prompt("third");
		expect(requestText(mock.calls[2]!.context)).toContain("Eve (e0e0e0)");
	});

	it("says nothing while a fresh engine is still discovering peers", async () => {
		const identity = { startedAt: Date.now() };
		const session = await boundSession(identity);
		const mock = createMockModel({ handler: { content: ["ok"] } });
		session.agent.streamFn = mock.stream;

		// Not found yet is not alone.
		await session.prompt("first");
		expect(noticeDetails(session)).toEqual([]);
		identity.startedAt = 0;
		peers = [peer("c0ffee", "Carol")];
		await session.prompt("second");
		expect(noticeDetails(session)).toEqual([{ added: [{ id: "c0ffee", name: "Carol" }], removed: [] }]);
	});

	it("does not report a peer the user hid as gone", async () => {
		const session = await boundSession();
		const mock = createMockModel({ handler: { content: ["ok"] } });
		session.agent.streamFn = mock.stream;

		peers = [peer("c0ffee", "Carol")];
		await session.prompt("first");
		peers = [{ ...peer("c0ffee", "Carol"), hidden: true }];
		await session.prompt("second");
		expect(noticeDetails(session)).toEqual([{ added: [{ id: "c0ffee", name: "Carol" }], removed: [] }]);
	});

	it("announces a peer only once its session has a name and a summary", async () => {
		const session = await boundSession();
		const mock = createMockModel({ handler: { content: ["ok"] } });
		session.agent.streamFn = mock.stream;

		// Just connected: nothing to say about it yet, so the roster reports no one.
		peers = [peer("f0f0f0", "Frank", null, null)];
		await session.prompt("first");
		// Either half alone is not enough.
		peers = [peer("f0f0f0", "Frank", "billing export", null)];
		await session.prompt("second");
		peers = [peer("f0f0f0", "Frank", null, "Exporting invoices to CSV.")];
		await session.prompt("third");
		peers = [peer("f0f0f0", "Frank", "billing export", "Exporting invoices to CSV.")];
		await session.prompt("fourth");

		expect(noticeDetails(session)).toEqual([
			{ added: [], removed: [] },
			{ added: [{ id: "f0f0f0", name: "Frank" }], removed: [] },
		]);
		expect(requestText(mock.calls[3]!.context)).toContain("Exporting invoices to CSV.");
	});
});
