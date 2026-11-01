/**
 * Frontend view of the mesh engine. The native implementation (Rust `MeshNode` behind N-API) owns
 * transport, crypto, discovery, the peer table, envelope checks and the correlation of answers
 * (`reply`, `watch_event`) with the requests that asked for them; everything in `src/mesh/` codes
 * against this interface so tests can drive it with fakes.
 */
import type { MeshStatus } from "@oh-my-pi/pi-natives";
import type { MeshEnvelope, MeshRequest, MeshResponse, MeshSender, MeshSnapshot, MeshWatchEvent } from "./wire";

export interface MeshPeerView {
	instanceId: string;
	endpoint: { kind: "local" } | { kind: "remote"; address: string; port: number; hostname?: string; dnsName?: string };
	source: "local" | "mdns" | "static" | "contact";
	state: "online" | "stale";
	lastSeen: number;
	hidden: boolean;
	blocked: boolean;
	snapshot: MeshSnapshot | null;
}

/** An authenticated envelope the engine could not answer itself. */
export interface MeshInboundRequest {
	requestId: string;
	envelope: MeshEnvelope;
	origin: { kind: "local" | "remote"; address?: string };
}

export type MeshInboundHandler = (request: MeshInboundRequest) => Promise<MeshResponse>;

export type MeshEngineErrorCode = "unreachable" | "timeout" | "aborted" | "bad_response";

/** Transport-level failure of {@link MeshEngine.request}; peer-level refusals arrive as `ok: false` responses. */
export class MeshEngineError extends Error {
	readonly code: MeshEngineErrorCode;

	constructor(code: MeshEngineErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "MeshEngineError";
		this.code = code;
	}
}

export interface MeshRequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/**
	 * Track the answers of a `message` (not a note) or `watch` under this frontend ticket once the
	 * peer acknowledged it: they resolve {@link MeshEngine.awaitReply}, or arrive through
	 * {@link MeshEngine.onReply} carrying the ticket.
	 */
	ticket?: string;
	/** Keep the first answer for an {@link MeshEngine.awaitReply} about to start (with `ticket`). */
	hold?: boolean;
}

/** An answer to a tracked request, with its sender. */
export type MeshIncomingReply =
	| { op: "reply"; from: MeshSender; replyTo: string; thread?: string; text: string; error?: string }
	| { op: "watch_event"; from: MeshSender; watchId: string; event: MeshWatchEvent; detail?: string };

export interface MeshEngine {
	readonly instanceId: string;
	status(): MeshStatus;
	peers(): MeshPeerView[];
	onPeersChanged(listener: () => void): () => void;
	onStatusChanged(listener: (status: MeshStatus) => void): () => void;
	/** One handler at a time; the engine answers the inbound request with its result. */
	setInboundHandler(handler: MeshInboundHandler): () => void;
	/**
	 * Rejects with {@link MeshEngineError} on transport failure. A `message` / `watch` acknowledgement
	 * without a valid `msgId` / `watchId` resolves to an `internal` error response.
	 */
	request(to: string, fromAgentId: string, body: MeshRequest, options?: MeshRequestOptions): Promise<MeshResponse>;
	/**
	 * Wait for the next answer to the tracked request `key` (a msgId or watchId). Resolves `undefined`
	 * when untracked, on timeout or abort, or when a newer wait for the same key replaces this one;
	 * later answers arrive through {@link onReply}.
	 */
	awaitReply(key: string, timeoutMs: number, signal?: AbortSignal): Promise<MeshIncomingReply | undefined>;
	/** Stop tracking the requests of `tickets`. */
	forgetPending(tickets: readonly string[]): void;
	/** Answers to tracked requests nobody awaits, by ticket. */
	onReply(listener: (ticket: string, reply: MeshIncomingReply) => void): () => void;
	/** Tickets the engine stopped tracking (TTL, size cap, close, or their peer left the mesh). */
	onPendingDropped(listener: (tickets: readonly string[]) => void): () => void;
	setSnapshot(snapshot: MeshSnapshot): void;
	refresh(): void;
	setPeerFlags(instanceId: string, flags: { hidden?: boolean; blocked?: boolean }): void;
}
