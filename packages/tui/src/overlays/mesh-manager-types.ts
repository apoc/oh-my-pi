/**
 * View model and host contract of the `/mesh` manager ({@link MeshManagerComponent}).
 * The coding agent adapts its mesh runtime to {@link MeshManagerRuntime}; every string
 * a peer supplied arrives raw and is sanitized by the component before it renders.
 */

export type MeshManagerMode = "local" | "remote" | "both";

/** Message kinds the human can send from the manager. */
export type MeshComposeKind = "status" | "ask" | "steer" | "note";

export const MESH_COMPOSE_KINDS: readonly MeshComposeKind[] = ["status", "ask", "steer", "note"];

export interface MeshManagerEngineStatus {
	local: "on" | "off" | "error";
	remote: "on" | "off" | "no-key" | "error";
	lanPort?: number;
	error?: string;
}

/** The running engine as this instance's peers see it. */
export interface MeshManagerSelf {
	instanceId: string;
	displayName: string;
	status: MeshManagerEngineStatus;
}

export interface MeshManagerAgent {
	id: string;
	kind: string;
	displayName: string;
	status: string;
	task?: string;
}

/** One peer that served a snapshot (peers without one are unverified and not listed). */
export interface MeshManagerPeer {
	instanceId: string;
	endpointKind: "local" | "remote";
	/** `local` | `remote <ip> · <dns|hostname>`. */
	endpoint: string;
	source: string;
	state: "online" | "stale";
	lastSeen: number;
	hidden: boolean;
	blocked: boolean;
	displayName: string;
	host: string;
	sessionName?: string;
	cwd: string;
	branch?: string;
	model?: string;
	busy: boolean;
	/** Multi-line smol summary. */
	summary?: string;
	agents: readonly MeshManagerAgent[];
}

export interface MeshManagerApproval {
	id: string;
	kind: string;
	fromName: string;
	fromHost: string;
	fromAgent: string;
	fromInstanceId: string;
	preview: string;
	expiresAt: number;
}

/** A thread the peer opened with this instance. */
export interface MeshManagerThread {
	threadId: string;
	kind: string;
	turns: number;
	status: string;
	lastQuestion?: string;
	updatedAt: number;
}

export interface MeshManagerState {
	enabled: boolean;
	mode: MeshManagerMode;
	hasKey: boolean;
	/** Absent while the mesh engine is not running. */
	self?: MeshManagerSelf;
	peers: readonly MeshManagerPeer[];
	approvals: readonly MeshManagerApproval[];
}

export type MeshSendOutcome = { ok: true; thread?: string } | { ok: false; message: string };

export interface MeshManagerRuntime {
	getState(): MeshManagerState;
	/** Fires on any change of the state; returns the unsubscriber. */
	subscribe(onChange: () => void): () => void;
	/** Persist `mesh.enabled`; throws when the setting cannot be written. */
	setEnabled(enabled: boolean): void;
	/** Persist `mesh.mode`; throws when the setting cannot be written. */
	setMode(mode: MeshManagerMode): void;
	/** Derive the group key from `phrase` and persist it; rejects when derivation fails or is unavailable. */
	setKeyPhrase(phrase: string): Promise<void>;
	setPeerFlags(instanceId: string, flags: { hidden?: boolean; blocked?: boolean }): void;
	resolveApproval(id: string, allow: boolean): void;
	refresh(): void;
	listThreads(peerInstanceId: string): Promise<readonly MeshManagerThread[]>;
	send(peerInstanceId: string, kind: MeshComposeKind, text: string): Promise<MeshSendOutcome>;
}
