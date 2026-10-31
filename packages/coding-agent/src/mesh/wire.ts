/**
 * Type-only mirror of the mesh wire protocol. The Rust engine (`crates/pi-mesh`) owns the serde
 * types, validation and size caps; TypeScript never re-validates what the engine already checked.
 */

export const MESH_PROTOCOL_VERSION = 1;
/** Cap on free-text payloads (`message`/`reply` text), enforced by the engine. */
export const MAX_TEXT_CHARS = 64 * 1024;
/** Cap on every other string field (ids, names, hosts, addresses), enforced by the engine. */
export const MAX_FIELD_CHARS = 1024;
/** Upper bound for a watch registration lifetime. */
export const MAX_WATCH_TTL_SEC = 3600;
/** Envelope `to` for a peer whose instance id is not known yet (static peers before the first snapshot). */
export const MESH_ANY_INSTANCE = "*";

/** Kinds carried by `op: "message"`. */
export type MeshMessageKind = "status" | "ask" | "task" | "steer" | "note";
/** Message kinds answered asynchronously in a thread. */
export type MeshThreadKind = "status" | "ask" | "task";
export type MeshWatchEvent = "idle" | "turn_end";

export interface MeshSender {
	instanceId: string;
	/** `Main` | subagent id | `user`. */
	agentId: string;
	displayName: string;
	host: string;
}

export type MeshRequest =
	| { op: "snapshot" }
	| { op: "message"; kind: MeshMessageKind; text: string; thread?: string }
	| { op: "reply"; replyTo: string; thread?: string; text: string; error?: string }
	| { op: "watch"; event: MeshWatchEvent; ttlSec: number }
	| { op: "watch_event"; watchId: string; event: MeshWatchEvent; detail?: string }
	| { op: "threads" }
	| { op: "thread"; thread: string };

export interface MeshEnvelope {
	v: 1;
	msgId: string;
	sentAt: number;
	hop: number;
	from: MeshSender;
	/** Recipient instance id, or {@link MESH_ANY_INSTANCE}. */
	to: string;
	body: MeshRequest;
}

export type MeshErrorCode =
	| "denied"
	| "busy"
	| "thread_expired"
	| "unknown_thread"
	| "bad_request"
	| "unauthorized"
	| "too_large"
	| "rate_limited"
	| "unsupported"
	| "internal";

export type MeshResponse = { ok: true; data: unknown } | { ok: false; code: MeshErrorCode; message: string };

/**
 * `data` of an accepted `message`. `msgId` echoes the request envelope id: the sender's engine
 * assigns it, so the ack is the only place the sender learns which `replyTo` the answer will carry.
 * `thread` is present for thread kinds (status/ask/task).
 */
export interface MeshMessageResult {
	accepted: true;
	msgId: string;
	thread?: string;
}

/** `data` of an accepted `watch`. */
export interface MeshWatchResult {
	watchId: string;
}

export interface MeshSnapshot {
	instanceId: string;
	displayName: string;
	host: string;
	pid: number;
	ompVersion: string;
	protocol: 1;
	sessionId: string | null;
	sessionName: string | null;
	summary: { text: string; updatedAt: number } | null;
	cwd: string;
	repo: { remote?: string; branch?: string; head?: string } | null;
	model: string | null;
	busy: boolean;
	agents: { id: string; kind: string; displayName: string; status: string; task?: string }[];
	startedAt: number;
}

export function meshError(code: MeshErrorCode, message: string): MeshResponse {
	return { ok: false, code, message };
}

export function meshOk(data: unknown): MeshResponse {
	return { ok: true, data };
}
