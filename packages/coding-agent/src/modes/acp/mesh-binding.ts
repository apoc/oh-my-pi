/**
 * ACP mesh participation: one mesh host per ACP connection, served from the newest open session.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { type MeshHostHandle, type MeshHostOptions, startMeshHost } from "../../mesh/host";
import type { AgentSession } from "../../session/agent-session";

/** After `dispose`, `sync` is a no-op: a session opened while the connection is closing never starts a host. */
export class AcpMeshBinding {
	readonly #startHost: (options: MeshHostOptions) => MeshHostHandle;
	/** Absent while no session is open. */
	#host: MeshHostHandle | undefined;
	/**
	 * Serializes `sync` and `dispose`: each runs after the previous one settled, so a host that is
	 * still closing (and holds its listener) is gone before the next one starts.
	 */
	#ops: Promise<void> = Promise.resolve();
	/**
	 * Set synchronously by `dispose`, so every `sync` still queued when it is called, before or after it,
	 * is refused when it runs.
	 */
	#closed = false;

	constructor(startHost: (options: MeshHostOptions) => MeshHostHandle = startMeshHost) {
		this.#startHost = startHost;
	}

	/**
	 * Serve the mesh from the newest of `sessions()` (the last in iteration order); leave it when
	 * there is none. `sessions` is read when this operation runs, after every earlier one settled,
	 * so a session closed while a host was still closing is never served. After `dispose` this is
	 * a no-op: it starts no host and reads no sessions. Never rejects.
	 */
	sync(sessions: () => Iterable<AgentSession>): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#closed) return;
			let newest: AgentSession | undefined;
			for (const session of sessions()) newest = session;
			const host = this.#host;
			if (!newest) {
				this.#host = undefined;
				await host?.dispose();
			} else if (host) {
				await host.setSession(newest);
			} else {
				this.#host = this.#startHost({ session: newest });
			}
		});
	}

	/**
	 * Leave the mesh once every earlier `sync` (a host still closing included) has settled. After
	 * this call `sync` is a no-op, queued ones that have not run yet included; the current host is
	 * still disposed here. Idempotent. Never rejects.
	 */
	dispose(): Promise<void> {
		this.#closed = true;
		return this.#enqueue(async () => {
			const host = this.#host;
			this.#host = undefined;
			await host?.dispose();
		});
	}

	#enqueue(op: () => Promise<void>): Promise<void> {
		this.#ops = this.#ops.then(op).catch(error => {
			logger.warn("ACP mesh binding operation failed", { error: String(error) });
		});
		return this.#ops;
	}
}
