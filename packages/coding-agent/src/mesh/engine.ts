/**
 * Frontend view of the mesh engine. The native implementation (Rust `MeshNode` behind N-API) owns
 * transport, crypto, discovery, the peer table and envelope checks; everything in `src/mesh/`
 * codes against this interface so tests can drive it with fakes.
 */
import type { MeshEnvelope, MeshRequest, MeshResponse, MeshSnapshot } from "./wire";

export type MeshMode = "off" | "local" | "remote" | "both";

export interface MeshStatus {
	mode: MeshMode;
	local: "on" | "off" | "error";
	remote: "on" | "off" | "no-key" | "error";
	lanPort?: number;
	error?: string;
}

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
}

export interface MeshEngine {
	readonly instanceId: string;
	status(): MeshStatus;
	peers(): MeshPeerView[];
	onPeersChanged(listener: () => void): () => void;
	onStatusChanged(listener: (status: MeshStatus) => void): () => void;
	/** One handler at a time; the engine answers the inbound request with its result. */
	setInboundHandler(handler: MeshInboundHandler): () => void;
	/** Rejects with {@link MeshEngineError} on transport failure. */
	request(to: string, fromAgentId: string, body: MeshRequest, options?: MeshRequestOptions): Promise<MeshResponse>;
	setSnapshot(snapshot: MeshSnapshot): void;
	refresh(): void;
	setPeerFlags(instanceId: string, flags: { hidden?: boolean; blocked?: boolean }): void;
}
