/**
 * The process mesh runtime: the engine plus the frontend pieces bound to the main session.
 * Host wiring installs it; tools, `mesh://` and the TUI read it and follow its changes.
 */
import type { AgentSession } from "../session/agent-session";
import type { MeshEngine } from "./engine";
import type { MeshFrontend } from "./inbound";
import type { MeshIdentity } from "./snapshot";
import type { MeshSummaryGenerator } from "./summary";

export interface MeshRuntime {
	readonly engine: MeshEngine;
	/** The top-level session the mesh is bound to; mesh tools are offered only there. */
	readonly session: AgentSession;
	/** Inbound routing; owns the approvals queue, outbound sender and thread store. */
	readonly frontend: MeshFrontend;
	readonly summary: MeshSummaryGenerator;
	/** This instance as peers see it (instance id, display name, host). */
	readonly identity: MeshIdentity;
}

let current: MeshRuntime | undefined;
const listeners = new Set<(runtime: MeshRuntime | undefined) => void>();

/** The running mesh runtime; `undefined` while the mesh is disabled or not started. */
export function getMeshRuntime(): MeshRuntime | undefined {
	return current;
}

/** Installs (or clears) the process mesh runtime; host wiring only. */
export function setMeshRuntime(runtime: MeshRuntime | undefined): void {
	if (current === runtime) return;
	current = runtime;
	for (const listener of listeners) listener(runtime);
}

/** Follows runtime installs and removals; returns the unsubscriber. */
export function onMeshRuntimeChanged(listener: (runtime: MeshRuntime | undefined) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
