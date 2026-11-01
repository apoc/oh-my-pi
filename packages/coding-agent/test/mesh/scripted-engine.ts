/**
 * Scripted {@link MeshEngine} for frontend tests. Answer correlation (early answers, held slots,
 * waiter replacement, TTL, cap eviction, foreign peers, malformed acks) is the Rust engine's and is
 * tested there; here tests script its observable outcomes: `answer(key, …)` resolves (or pre-loads)
 * an `awaitReply`, `late(key, …)` emits a reply event, `drop(keys)` a pending_dropped event.
 */
import type {
	MeshEngine,
	MeshIncomingReply,
	MeshInboundHandler,
	MeshPeerView,
	MeshRequestOptions,
	MeshStatus,
} from "../../src/mesh/engine";
import type { MeshRequest, MeshResponse } from "../../src/mesh/wire";

export interface SentRequest {
	to: string;
	fromAgentId: string;
	body: MeshRequest;
}

export class ScriptedMeshEngine implements MeshEngine {
	readonly instanceId = "inst-self";
	readonly sent: SentRequest[] = [];
	/** Request options in `sent` order. */
	readonly options: (MeshRequestOptions | undefined)[] = [];
	/** Tickets passed to `forgetPending`, in call order. */
	readonly forgotten: string[] = [];
	/** Acknowledgement of each request; defaults to {@link defaultResponse}. */
	respond: (request: SentRequest) => MeshResponse = request => this.defaultResponse(request);
	readonly #peers: MeshPeerView[];
	/** Acked key (`msgId` / `watchId`) → ticket of the request it acknowledged. */
	readonly #tickets = new Map<string, string>();
	readonly #answers = new Map<string, MeshIncomingReply>();
	readonly #waits = new Map<string, (reply: MeshIncomingReply | undefined) => void>();
	readonly #replyListeners = new Set<(ticket: string, reply: MeshIncomingReply) => void>();
	readonly #droppedListeners = new Set<(tickets: readonly string[]) => void>();

	constructor(peers: MeshPeerView[] = []) {
		this.#peers = peers;
	}

	/** `msg-<n>` acks on thread `thread-1` for messages, `w-<n>` for watches, `{accepted}` otherwise. */
	defaultResponse(request: SentRequest): MeshResponse {
		const n = this.sent.length;
		if (request.body.op === "message") {
			return { ok: true, data: { accepted: true, msgId: `msg-${n}`, thread: "thread-1" } };
		}
		if (request.body.op === "watch") return { ok: true, data: { watchId: `w-${n}` } };
		return { ok: true, data: { accepted: true } };
	}

	status(): MeshStatus {
		return { mode: "local", local: "on", remote: "off" };
	}
	peers(): MeshPeerView[] {
		return this.#peers;
	}
	onPeersChanged() {
		return () => {};
	}
	onStatusChanged() {
		return () => {};
	}
	setInboundHandler(_handler: MeshInboundHandler) {
		return () => {};
	}
	async request(to: string, fromAgentId: string, body: MeshRequest, options?: MeshRequestOptions) {
		const request = { to, fromAgentId, body };
		this.sent.push(request);
		this.options.push(options);
		const response = this.respond(request);
		if (response.ok && options?.ticket && typeof response.data === "object" && response.data !== null) {
			const data = response.data as { msgId?: unknown; watchId?: unknown };
			const key = typeof data.msgId === "string" ? data.msgId : data.watchId;
			if (typeof key === "string") this.#tickets.set(key, options.ticket);
		}
		return response;
	}
	setSnapshot() {}
	refresh() {}
	setPeerFlags() {}

	awaitReply(key: string, timeoutMs: number, signal?: AbortSignal): Promise<MeshIncomingReply | undefined> {
		const ready = this.#answers.get(key);
		if (ready) {
			this.#answers.delete(key);
			return Promise.resolve(ready);
		}
		const { promise, resolve } = Promise.withResolvers<MeshIncomingReply | undefined>();
		const finish = (reply: MeshIncomingReply | undefined) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			this.#waits.delete(key);
			resolve(reply);
		};
		const onAbort = () => finish(undefined);
		const timer = setTimeout(onAbort, timeoutMs);
		this.#waits.set(key, finish);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		return promise;
	}

	forgetPending(tickets: readonly string[]): void {
		this.forgotten.push(...tickets);
	}

	onReply(listener: (ticket: string, reply: MeshIncomingReply) => void): () => void {
		this.#replyListeners.add(listener);
		return () => this.#replyListeners.delete(listener);
	}

	onPendingDropped(listener: (tickets: readonly string[]) => void): () => void {
		this.#droppedListeners.add(listener);
		return () => this.#droppedListeners.delete(listener);
	}

	/** The engine's answer for `key`: resolves a running wait, else is kept for the next one. */
	answer(key: string, reply: MeshIncomingReply): void {
		const wait = this.#waits.get(key);
		if (wait) wait(reply);
		else this.#answers.set(key, reply);
	}

	/** Ticket the request acknowledged with `key` carried. */
	ticketOf(key: string): string {
		const ticket = this.#tickets.get(key);
		if (!ticket) throw new Error(`no tracked request acknowledged as ${key}`);
		return ticket;
	}

	/** A `reply` event: an answer nobody awaits, for the request acknowledged as `key`. */
	late(key: string, reply: MeshIncomingReply): void {
		const ticket = this.ticketOf(key);
		for (const listener of this.#replyListeners) listener(ticket, reply);
	}

	/** A `pending_dropped` event for the requests acknowledged as `keys`. */
	drop(keys: string[]): void {
		const tickets = keys.map(key => this.ticketOf(key));
		for (const listener of this.#droppedListeners) listener(tickets);
	}

	replies(): Extract<MeshRequest, { op: "reply" }>[] {
		return this.sent.flatMap(request => (request.body.op === "reply" ? [request.body] : []));
	}
}
