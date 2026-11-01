/**
 * {@link MeshEngine} over the native `MeshNode` (Rust engine behind N-API): JSON at the boundary,
 * typed values and listener fan-out on this side. The engine validates every payload it hands over
 * (envelopes, answers, snapshots), so this side only parses.
 */
import {
	type MeshConfig,
	type MeshEvent,
	MeshNode,
	type MeshNodeOptions,
	type MeshPeerInfo,
	type MeshStatus as NativeMeshStatus,
} from "@oh-my-pi/pi-natives";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import {
	type MeshEngine,
	MeshEngineError,
	type MeshEngineErrorCode,
	type MeshInboundHandler,
	type MeshInboundRequest,
	type MeshIncomingReply,
	type MeshMode,
	type MeshPeerView,
	type MeshRequestOptions,
	type MeshStatus,
} from "./engine";
import { type MeshEnvelope, type MeshRequest, type MeshResponse, type MeshSnapshot, meshError } from "./wire";

/** Request deadline when the caller sets none. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const ENGINE_ERROR_PREFIX = /^(unreachable|timeout|aborted|bad_response):\s*/;
/** Engine rejection of a response over a protocol size cap (`mesh … exceeds <limit>`). */
const SIZE_CAP_ERROR = /\bexceeds\b/;
const MESH_MODES: readonly MeshMode[] = ["off", "local", "remote", "both"];

export class NativeMeshEngine implements MeshEngine {
	readonly #node: MeshNode;
	readonly #peerListeners = new Set<() => void>();
	readonly #statusListeners = new Set<(status: MeshStatus) => void>();
	readonly #replyListeners = new Set<(ticket: string, reply: MeshIncomingReply) => void>();
	readonly #droppedListeners = new Set<(tickets: readonly string[]) => void>();
	#handler: MeshInboundHandler | undefined;
	/** Parsed peer snapshots keyed by instance id; reused while the peer's JSON is unchanged. */
	readonly #snapshots = new Map<string, { json: string; snapshot: MeshSnapshot | null }>();
	#closed: Promise<void> | undefined;
	/** Why the last `configure` was rejected (bad settings); reported in {@link status} until one succeeds. */
	#configureError: string | undefined;

	constructor(options: MeshNodeOptions) {
		this.#node = MeshNode.create(options, event => this.#onEvent(event));
	}

	get instanceId(): string {
		return this.#node.instanceId;
	}

	/**
	 * Reconcile the node's local/LAN sides, discovery and static peers with `config`. A rejected
	 * configuration does not throw: it is reported as `status().error` (and to status listeners)
	 * until a later `configure` succeeds.
	 */
	async configure(config: MeshConfig): Promise<MeshStatus> {
		const previous = this.#configureError;
		try {
			await this.#node.configure(config);
			this.#configureError = undefined;
		} catch (error) {
			this.#configureError = `Invalid mesh configuration: ${toError(error).message}`;
		}
		const status = this.status();
		if (this.#configureError !== previous) this.#emitStatus(status);
		return status;
	}

	status(): MeshStatus {
		const status = toStatus(this.#node.status());
		return this.#configureError ? { ...status, error: this.#configureError } : status;
	}

	peers(): MeshPeerView[] {
		const infos = this.#node.peers();
		const seen = new Set<string>();
		const views = infos.map(info => {
			seen.add(info.instanceId);
			return this.#toPeerView(info);
		});
		for (const id of this.#snapshots.keys()) if (!seen.has(id)) this.#snapshots.delete(id);
		return views;
	}

	onPeersChanged(listener: () => void): () => void {
		this.#peerListeners.add(listener);
		return () => this.#peerListeners.delete(listener);
	}

	onStatusChanged(listener: (status: MeshStatus) => void): () => void {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	}

	setInboundHandler(handler: MeshInboundHandler): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}

	async request(
		to: string,
		fromAgentId: string,
		body: MeshRequest,
		options?: MeshRequestOptions,
	): Promise<MeshResponse> {
		const signal = options?.signal;
		let raw: string;
		try {
			raw = await this.#node.request(
				to,
				fromAgentId,
				JSON.stringify(body),
				{
					timeoutMs: options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
					ticket: options?.ticket,
					hold: options?.hold,
				},
				signal,
			);
		} catch (error) {
			throw toEngineError(error, signal);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new MeshEngineError("bad_response", "Peer response is not valid JSON.", { cause: error });
		}
		if (!isMeshResponse(parsed)) throw new MeshEngineError("bad_response", "Peer response has an invalid shape.");
		return parsed;
	}

	async awaitReply(key: string, timeoutMs: number, signal?: AbortSignal): Promise<MeshIncomingReply | undefined> {
		let json: string | null;
		try {
			json = await this.#node.awaitReply(key, timeoutMs, signal);
		} catch (error) {
			logger.warn("mesh: waiting for a reply failed", { error: toError(error).message });
			return undefined;
		}
		return json === null ? undefined : (parseReply(json) ?? undefined);
	}

	forgetPending(tickets: readonly string[]): void {
		if (tickets.length > 0) this.#node.forgetPending([...tickets]);
	}

	onReply(listener: (ticket: string, reply: MeshIncomingReply) => void): () => void {
		this.#replyListeners.add(listener);
		return () => this.#replyListeners.delete(listener);
	}

	onPendingDropped(listener: (tickets: readonly string[]) => void): () => void {
		this.#droppedListeners.add(listener);
		return () => this.#droppedListeners.delete(listener);
	}

	setSnapshot(snapshot: MeshSnapshot): void {
		try {
			this.#node.setSnapshot(JSON.stringify(snapshot));
		} catch (error) {
			logger.warn("mesh: engine rejected snapshot", { error: toError(error).message });
		}
	}

	refresh(): void {
		this.#node.refresh();
	}

	setPeerFlags(instanceId: string, flags: { hidden?: boolean; blocked?: boolean }): void {
		const current = this.#node.peers().find(peer => peer.instanceId === instanceId);
		this.#node.setPeerFlags(
			instanceId,
			flags.hidden ?? current?.hidden ?? false,
			flags.blocked ?? current?.blocked ?? false,
		);
	}

	/** Withdraw from the mesh; idempotent. Listeners and the inbound handler are dropped. */
	close(): Promise<void> {
		if (!this.#closed) {
			this.#handler = undefined;
			this.#peerListeners.clear();
			this.#statusListeners.clear();
			this.#replyListeners.clear();
			this.#droppedListeners.clear();
			this.#snapshots.clear();
			this.#closed = this.#node.close();
		}
		return this.#closed;
	}

	#onEvent(event: MeshEvent): void {
		switch (event.kind) {
			case "peers":
				for (const listener of this.#peerListeners) callListener(() => listener());
				return;
			case "status":
				if (this.#statusListeners.size > 0) this.#emitStatus(this.status());
				return;
			case "inbound":
				void this.#onInbound(event);
				return;
			case "reply":
				this.#onReply(event);
				return;
			case "pending_dropped": {
				const tickets = event.tickets ?? [];
				for (const listener of this.#droppedListeners) callListener(() => listener(tickets));
				return;
			}
		}
	}

	#onReply(event: MeshEvent): void {
		const reply = event.envelopeJson ? parseReply(event.envelopeJson) : null;
		const ticket = event.ticket;
		if (!ticket || !reply) {
			logger.warn("mesh: malformed reply event");
			return;
		}
		for (const listener of this.#replyListeners) callListener(() => listener(ticket, reply));
	}

	#emitStatus(status: MeshStatus): void {
		for (const listener of this.#statusListeners) callListener(() => listener(status));
	}

	async #onInbound(event: MeshEvent): Promise<void> {
		const requestId = event.requestId;
		if (!requestId) {
			logger.warn("mesh: inbound event without request id");
			return;
		}
		let response: MeshResponse;
		const request = parseInbound(requestId, event);
		const handler = this.#handler;
		if (!request) {
			response = meshError("bad_request", "Malformed envelope.");
		} else if (!handler) {
			response = meshError("unsupported", "This instance does not serve mesh requests.");
		} else {
			try {
				response = await handler(request);
			} catch (error) {
				logger.warn("mesh: inbound handler failed", { error: toError(error).message });
				response = meshError("internal", "Request handling failed.");
			}
		}
		if (this.#closed) return;
		try {
			this.#node.respond(requestId, JSON.stringify(response));
		} catch (error) {
			const message = toError(error).message;
			logger.warn("mesh: responding to inbound request failed", { error: message });
			// Tell the peer now instead of letting it time out. The engine's size-cap rejections
			// read "… exceeds <limit>"; anything else is our own malformed response.
			const fallback = SIZE_CAP_ERROR.test(message)
				? meshError("too_large", "Response exceeds the mesh size limits.")
				: meshError("internal", "Response could not be sent.");
			try {
				this.#node.respond(requestId, JSON.stringify(fallback));
			} catch {
				// The engine already dropped the request (late or closed); nothing more to send.
			}
		}
	}

	#toPeerView(info: MeshPeerInfo): MeshPeerView {
		return {
			instanceId: info.instanceId,
			endpoint:
				info.endpointKind === "local"
					? { kind: "local" }
					: {
							kind: "remote",
							address: info.address ?? "",
							port: info.port ?? 0,
							hostname: info.hostname,
							dnsName: info.dnsName,
						},
			source: info.source,
			state: info.state,
			lastSeen: info.lastSeen,
			hidden: info.hidden,
			blocked: info.blocked,
			snapshot: this.#snapshotOf(info),
		};
	}

	#snapshotOf(info: MeshPeerInfo): MeshSnapshot | null {
		const json = info.snapshotJson;
		if (!json) {
			this.#snapshots.delete(info.instanceId);
			return null;
		}
		const cached = this.#snapshots.get(info.instanceId);
		if (cached?.json === json) return cached.snapshot;
		const snapshot = parseSnapshot(json);
		this.#snapshots.set(info.instanceId, { json, snapshot });
		return snapshot;
	}
}

function callListener(run: () => void): void {
	try {
		run();
	} catch (error) {
		logger.warn("mesh: engine listener failed", { error: toError(error).message });
	}
}

function toStatus(status: NativeMeshStatus): MeshStatus {
	const mode = MESH_MODES.find(candidate => candidate === status.mode) ?? "off";
	return { ...status, mode };
}

function toEngineError(error: unknown, signal: AbortSignal | undefined): MeshEngineError {
	const err = toError(error);
	const match = ENGINE_ERROR_PREFIX.exec(err.message);
	if (match) {
		const code = match[1] as MeshEngineErrorCode;
		return new MeshEngineError(code, err.message.slice(match[0].length) || code, { cause: err });
	}
	if (signal?.aborted) return new MeshEngineError("aborted", "Request aborted.", { cause: err });
	return new MeshEngineError("unreachable", err.message, { cause: err });
}

function parseInbound(requestId: string, event: MeshEvent): MeshInboundRequest | null {
	if (!event.envelopeJson) return null;
	let envelope: unknown;
	try {
		envelope = JSON.parse(event.envelopeJson);
	} catch {
		return null;
	}
	if (!isRecord(envelope) || !isRecord(envelope.body) || !isRecord(envelope.from)) return null;
	return {
		requestId,
		// The engine validated the envelope against the serde wire types before raising the event.
		envelope: envelope as unknown as MeshEnvelope,
		origin: { kind: event.originKind ?? "local", address: event.originAddress },
	};
}

function isMeshResponse(value: unknown): value is MeshResponse {
	if (!isRecord(value)) return false;
	if (value.ok === true) return "data" in value;
	return value.ok === false && typeof value.code === "string" && typeof value.message === "string";
}

/** An answer envelope from the engine (validated against the serde wire types) as `{...body, from}`. */
function parseReply(json: string): MeshIncomingReply | null {
	let envelope: unknown;
	try {
		envelope = JSON.parse(json);
	} catch {
		return null;
	}
	if (!isRecord(envelope) || !isRecord(envelope.body) || !isRecord(envelope.from)) return null;
	const { body, from } = envelope as unknown as MeshEnvelope;
	if (body.op !== "reply" && body.op !== "watch_event") return null;
	return { ...body, from };
}

/**
 * A peer's snapshot. The engine validated it (shape, caps, instance id of the peer it was fetched
 * from) before storing it; `null` only if the JSON does not parse.
 */
function parseSnapshot(json: string): MeshSnapshot | null {
	try {
		return JSON.parse(json) as MeshSnapshot;
	} catch {
		return null;
	}
}
