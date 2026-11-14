import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { InstanceHost, type MeshConfig } from "@oh-my-pi/pi-natives";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import * as instances from "../../src/instances";
import { type MeshHostHandle, startMeshHost } from "../../src/mesh/host";
import { NativeMeshEngine } from "../../src/mesh/native-engine";
import { MESH_PEERS_NOTICE_TYPE } from "../../src/mesh/peer-notice";
import { getMeshRuntime, type MeshRuntime, onMeshRuntimeChanged, setMeshRuntime } from "../../src/mesh/runtime";
import { cfgMeshInboundTask } from "../../src/mesh/settings";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession, SessionNoticeSource } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

const MESH_SETTINGS = { "archive.enabled": false, "mesh.enabled": true, "mesh.mode": "local", "mesh.port": 0 } as const;

/** One registered notice source and how many times its remover ran. */
interface TrackedSource {
	removals: number;
}

/** Records every notice source the session registers (still registering it for real) and its remover calls. */
function trackNoticeSources(session: AgentSession): {
	sources: TrackedSource[];
	/** The registered source functions, parallel to `sources`. */
	registered: SessionNoticeSource[];
	spy: Mock<typeof session.addNoticeSource>;
} {
	const sources: TrackedSource[] = [];
	const registered: SessionNoticeSource[] = [];
	const register = session.addNoticeSource.bind(session);
	const spy = spyOn(session, "addNoticeSource").mockImplementation(source => {
		const tracked: TrackedSource = { removals: 0 };
		sources.push(tracked);
		registered.push(source);
		const remove = register(source);
		return () => {
			tracked.removals++;
			remove();
		};
	});
	return { sources, registered, spy };
}

/** Resolves with the first installed runtime that satisfies `matches`, now or once the host installs it. */
function runtimeWhere(matches: (runtime: MeshRuntime) => boolean): Promise<MeshRuntime> {
	const current = getMeshRuntime();
	if (current && matches(current)) return Promise.resolve(current);
	const found = Promise.withResolvers<MeshRuntime>();
	const stop = onMeshRuntimeChanged(runtime => {
		if (runtime && matches(runtime)) found.resolve(runtime);
	});
	return found.promise.finally(stop);
}

/** Resolves with the first `configure` call's config satisfying `matches`, including calls made before waiting. */
class ConfigureWatcher {
	readonly calls: MeshConfig[] = [];
	readonly #waiters: { matches: (config: MeshConfig) => boolean; resolve: (config: MeshConfig) => void }[] = [];

	record(config: MeshConfig): void {
		this.calls.push(config);
		for (const waiter of this.#waiters.filter(candidate => candidate.matches(config))) waiter.resolve(config);
	}

	next(matches: (config: MeshConfig) => boolean, from = 0): Promise<MeshConfig> {
		const seen = this.calls.slice(from).find(matches);
		if (seen) return Promise.resolve(seen);
		const found = Promise.withResolvers<MeshConfig>();
		this.#waiters.push({ matches, resolve: found.resolve });
		return found.promise;
	}
}

describe("mesh host", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let instanceHost: InstanceHost;
	let sharedSpy: Mock<typeof instances.sharedInstanceHost>;
	const sessions: AgentSession[] = [];
	const handles: MeshHostHandle[] = [];

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-mesh-host-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		// Every engine serves this private registry, so no test touches the real instance registry.
		instanceHost = new InstanceHost({ dir: fs.mkdtempSync(path.join(dir, "registry-")) });
		sharedSpy = spyOn(instances, "sharedInstanceHost").mockReturnValue(instanceHost);
	});

	afterEach(async () => {
		for (const handle of handles.splice(0)) await handle.dispose();
		setMeshRuntime(undefined);
		sharedSpy.mockRestore();
		await instanceHost.close();
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(dir)) removeSyncWithRetries(dir);
	});

	async function newSession(overrides: Record<string, unknown> = {}): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ ...MESH_SETTINGS, ...overrides }),
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
		return session;
	}

	function startHost(session: AgentSession): MeshHostHandle {
		const handle = startMeshHost({ session });
		handles.push(handle);
		return handle;
	}

	it("registers the peer notice on the served session and moves it with the session", async () => {
		const first = await newSession();
		const second = await newSession();
		const firstNotices = trackNoticeSources(first);
		const secondNotices = trackNoticeSources(second);
		try {
			const handle = startHost(first);
			await runtimeWhere(runtime => runtime.session === first);
			expect(firstNotices.sources).toEqual([{ removals: 0 }]);
			// The registered source is the mesh peer notice: past the discovery window it speaks (alone or a roster).
			getMeshRuntime()!.identity.startedAt = 0;
			expect(firstNotices.registered[0]!("prompt")?.customType).toBe(MESH_PEERS_NOTICE_TYPE);
			expect(secondNotices.sources).toEqual([]);

			await handle.setSession(second);
			expect(getMeshRuntime()?.session).toBe(second);
			expect(firstNotices.sources).toEqual([{ removals: 1 }]);
			expect(secondNotices.sources).toEqual([{ removals: 0 }]);

			await handle.dispose();
			expect(getMeshRuntime()).toBeUndefined();
			expect(firstNotices.sources).toEqual([{ removals: 1 }]);
			expect(secondNotices.sources).toEqual([{ removals: 1 }]);
		} finally {
			firstNotices.spy.mockRestore();
			secondNotices.spy.mockRestore();
		}
	});

	it("reconfigures the running engine when an inbound policy flips to deny", async () => {
		const session = await newSession({ "mesh.inbound.task": "allow" });
		const watcher = new ConfigureWatcher();
		const realConfigure = NativeMeshEngine.prototype.configure;
		const configureSpy = spyOn(NativeMeshEngine.prototype, "configure").mockImplementation(
			function (this: NativeMeshEngine, config) {
				watcher.record(config);
				return realConfigure.call(this, config);
			},
		);
		try {
			startHost(session);
			const initial = await watcher.next(() => true);
			expect(initial.deniedKinds).not.toContain("task");

			cfgMeshInboundTask.override(session.settings, "deny");
			const denied = await watcher.next(config => config.deniedKinds.includes("task"), 1);
			expect(denied.mode).toBe("local");
		} finally {
			configureSpy.mockRestore();
		}
	});

	describe("mesh tools follow the runtime", () => {
		it("offers mesh_peers to the served session and withdraws it when the host is disposed", async () => {
			const session = await newSession();
			expect(session.hasBuiltInTool("mesh_peers")).toBe(false);
			const handle = startHost(session);
			await runtimeWhere(runtime => runtime.session === session);
			await session.runToolRegistryMutation(async () => {});
			expect(session.hasBuiltInTool("mesh_peers")).toBe(true);

			await handle.dispose();
			await session.runToolRegistryMutation(async () => {});
			expect(session.hasBuiltInTool("mesh_peers")).toBe(false);
		});
	});
});
