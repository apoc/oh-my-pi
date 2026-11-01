/**
 * Runs the mesh for one top-level host (interactive TUI, RPC, ACP): starts the native engine
 * while `mesh.enabled` is on, binds the frontend pieces to the host's main session, installs
 * the process {@link MeshRuntime}, and follows the `mesh.*` settings live. Subagents and print
 * mode never start a host.
 */
import * as os from "node:os";
import { logger, postmortem, toError } from "@oh-my-pi/pi-utils";
import { cfgCollabDisplayName } from "../collab/settings";
import { sharedInstanceHost } from "../instances";
import type { AgentSession } from "../session/agent-session";
import type { MeshUiHooks } from "./bridge";
import { MeshFrontend } from "./inbound";
import { NativeMeshEngine } from "./native-engine";
import { MeshOutbound } from "./outbound";
import { MeshResponder } from "./responder";
import { getMeshRuntime, type MeshRuntime, setMeshRuntime } from "./runtime";
import {
	cfgMeshDisplayName,
	cfgMeshEnabled,
	cfgMeshKey,
	cfgMeshMode,
	cfgMeshPeers,
	cfgMeshPort,
	meshConfigFromSettings,
} from "./settings";
import { type MeshIdentity, MeshSnapshotPublisher } from "./snapshot";
import { MeshSummaryGenerator } from "./summary";

export interface MeshHostOptions {
	/** The host's main session; its settings drive the mesh. */
	session: AgentSession;
	/** Human-facing surface; omitted when headless (`ask` policies then deny). */
	ui?: MeshUiHooks;
}

export interface MeshHostHandle {
	/** Serve a different main session (ACP: the newest open session); the engine keeps running. Never rejects. */
	setSession(session: AgentSession): Promise<void>;
	/** Leave the mesh and stop following settings; never rejects. */
	dispose(): Promise<void>;
}

/** Engine plus the pieces bound to the current session while the mesh is on. */
interface RunningMesh {
	readonly engine: NativeMeshEngine;
	readonly identity: MeshIdentity;
	readonly summary: MeshSummaryGenerator;
	readonly publisher: MeshSnapshotPublisher;
	readonly outbound: MeshOutbound;
	binding: SessionBinding | undefined;
}

interface SessionBinding {
	readonly runtime: MeshRuntime;
	readonly detachSummary: () => void;
	stopPublisher: () => void;
}

export function startMeshHost(options: MeshHostOptions): MeshHostHandle {
	return new MeshHost(options);
}

class MeshHost implements MeshHostHandle {
	#session: AgentSession;
	readonly #ui: MeshUiHooks | undefined;
	#running: RunningMesh | undefined;
	#unlisten: (() => void)[] = [];
	/** Serializes start/stop/reconfigure so setting bursts never interleave engine calls. */
	#ops: Promise<void> = Promise.resolve();
	#disposed = false;
	readonly #cancelPostmortem: () => void;

	constructor(options: MeshHostOptions) {
		this.#session = options.session;
		this.#ui = options.ui;
		// Signals and fatal exits: drop the `mesh` capability and send the mDNS goodbye (the shared
		// instance host's own exit hook withdraws the registry entry).
		this.#cancelPostmortem = postmortem.register("mesh-host", () => this.dispose(), { exitOnly: true });
		this.#listen();
		this.#enqueue(() => this.#reconcile());
	}

	setSession(session: AgentSession): Promise<void> {
		if (this.#disposed || session === this.#session) return this.#ops;
		this.#session = session;
		this.#listen();
		this.#enqueue(async () => {
			const running = this.#running;
			if (running) {
				this.#unbind(running);
				this.#bind(running);
			}
			await this.#reconcile();
		});
		return this.#ops;
	}

	dispose(): Promise<void> {
		if (!this.#disposed) {
			this.#disposed = true;
			this.#stopListening();
			// Keep the exit cleanup until the engine is closed: an exit during the close still awaits it.
			this.#enqueue(async () => {
				try {
					await this.#stop();
				} finally {
					this.#cancelPostmortem();
				}
			});
		}
		return this.#ops;
	}

	#listen(): void {
		this.#stopListening();
		const settings = this.#session.settings;
		const reconcile = () => this.#enqueue(() => this.#reconcile());
		this.#unlisten = [
			cfgMeshEnabled.listen(settings, reconcile),
			cfgMeshMode.listen(settings, reconcile),
			cfgMeshKey.listen(settings, reconcile),
			cfgMeshPort.listen(settings, reconcile),
			cfgMeshPeers.listen(settings, reconcile),
			cfgMeshDisplayName.listen(settings, reconcile),
			cfgCollabDisplayName.listen(settings, reconcile),
		];
	}

	#stopListening(): void {
		for (const unlisten of this.#unlisten) unlisten();
		this.#unlisten = [];
	}

	#enqueue(op: () => Promise<void>): void {
		this.#ops = this.#ops.then(op).catch(error => {
			logger.warn("mesh: host operation failed", { error: toError(error).message });
		});
	}

	async #reconcile(): Promise<void> {
		const settings = this.#session.settings;
		if (this.#disposed || !cfgMeshEnabled.get(settings)) {
			await this.#stop();
			return;
		}
		const config = meshConfigFromSettings(settings);
		let running = this.#running;
		if (!running) {
			running = this.#start(config.displayName);
		} else if (running.identity.displayName !== config.displayName) {
			running.identity.displayName = config.displayName;
			// Republish now (the publisher otherwise rebuilds only on session activity).
			if (running.binding) {
				const { publisher, engine, identity, summary } = running;
				running.binding.stopPublisher = publisher.start(this.#session, engine, identity, summary);
			}
		}
		const status = await running.engine.configure(config);
		if (status.error) logger.warn("mesh: engine reported an error", { error: status.error });
	}

	#start(displayName: string): RunningMesh {
		const host = os.hostname();
		// The previous engine (if any) is fully closed before a new one starts: ops are serialized. Every
		// engine serves the process's shared instance host, so the instance id stays the same across
		// restarts (peers key threads and replies on it).
		const engine = new NativeMeshEngine({ host: sharedInstanceHost(), hostName: host });
		const running: RunningMesh = {
			engine,
			identity: { instanceId: engine.instanceId, displayName, host, startedAt: Date.now() },
			summary: new MeshSummaryGenerator(),
			publisher: new MeshSnapshotPublisher(),
			// Outlives session rebinds so replies to in-flight sends still find their asker.
			outbound: new MeshOutbound({ engine, main: this.#session, ui: this.#ui }),
			binding: undefined,
		};
		this.#running = running;
		this.#bind(running);
		return running;
	}

	#bind(running: RunningMesh): void {
		const session = this.#session;
		const { engine, identity, summary, publisher, outbound } = running;
		const detachSummary = summary.attach(session);
		const stopPublisher = publisher.start(session, engine, identity, summary);
		const frontend = MeshFrontend.attach({
			engine,
			session,
			settings: session.settings,
			answerer: new MeshResponder(session),
			ui: this.#ui,
			outbound,
		});
		const runtime: MeshRuntime = { engine, session, frontend, summary, identity };
		running.binding = { runtime, detachSummary, stopPublisher };
		setMeshRuntime(runtime);
	}

	#unbind(running: RunningMesh): void {
		const binding = running.binding;
		if (!binding) return;
		running.binding = undefined;
		if (getMeshRuntime() === binding.runtime) setMeshRuntime(undefined);
		binding.runtime.frontend.detach();
		binding.stopPublisher();
		binding.detachSummary();
	}

	async #stop(): Promise<void> {
		const running = this.#running;
		if (!running) return;
		this.#running = undefined;
		this.#unbind(running);
		running.outbound.dispose();
		await running.summary.settled();
		await running.engine.close();
	}
}
