/**
 * Threads of inbound status/ask/task questions, per recipient session. Records live in memory and
 * are mirrored file-per-thread under `<artifacts>/mesh-threads/` (atomic writes, revision guard),
 * so a resumed session keeps answering follow-ups. A session switch expires every thread; a thread
 * idle past `mesh.threadTtlHours` is forgotten. Only the asking instance can see or continue its
 * threads: anyone else gets `unknown_thread`, exactly as for an id that never existed.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, logger, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { writeFileAtomically } from "../utils/atomic-file";
import { MESH_THREADS_DIRNAME } from "../internal-urls/registry-helpers";
import type { MeshErrorCode, MeshSender, MeshThreadKind } from "./wire";

type MeshTurnStatus = "queued" | "running" | "complete" | "error" | "interrupted";

interface MeshThreadTurn {
	/** Envelope id of the question; the answer's `replyTo`. */
	msgId: string;
	question: string;
	answer?: string;
	error?: string;
	status: MeshTurnStatus;
	createdAt: number;
	updatedAt: number;
}

export interface MeshThreadRecord {
	threadId: string;
	kind: MeshThreadKind;
	/** The asking peer; only its instance may read or continue the thread. */
	peer: MeshSender;
	mainSessionId: string;
	/** Responder subagent kept alive for follow-ups (ask/task). */
	forkAgentId?: string;
	/** Main session leaf the ask responder was forked at. */
	forkLeafId?: string | null;
	turns: MeshThreadTurn[];
	createdAt: number;
	updatedAt: number;
}

type MeshThreadLookup =
	| { ok: true; record: MeshThreadRecord }
	| { ok: false; code: Extract<MeshErrorCode, "unknown_thread" | "thread_expired">; message: string };

/** The parts of an agent session the store follows. */
export interface MeshThreadHost {
	getSessionId(): string;
	getArtifactsDir(): string | null;
	registerSessionChangeCallback(callback: () => void): () => void;
}

const THREAD_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
/** Remembered expired ids, so a late follow-up hears `thread_expired` rather than `unknown_thread`. */
const MAX_EXPIRED_IDS = 4096;
/** Unanswered (queued or running) turns one peer instance may hold across its threads. */
export const MESH_MAX_UNANSWERED_PER_PEER = 8;
/** Unanswered turns across all peers (instance ids are self-claimed, so the per-peer cap alone does not bound them). */
export const MESH_MAX_UNANSWERED_TOTAL = 32;
/** Turns one thread may hold; past it the peer starts a new thread (each turn rewrites the whole record). */
export const MESH_MAX_TURNS_PER_THREAD = 32;
/** Live thread records (answered ones included) one peer instance may hold; past it the oldest idle ones are evicted. */
export const MESH_MAX_THREADS_PER_PEER = 64;
/** Live thread records across all peers; past it the oldest idle ones are evicted. */
export const MESH_MAX_THREADS_TOTAL = 512;

/** A question refused by a store bound; `code` and `message` are safe to show the asking peer. */
export class MeshThreadLimitError extends Error {
	constructor(
		readonly code: Extract<MeshErrorCode, "busy" | "bad_request" | "thread_expired">,
		message: string,
	) {
		super(message);
		this.name = "MeshThreadLimitError";
	}
}

const peerSchema = type({
	instanceId: "string",
	agentId: "string",
	displayName: "string",
	host: "string",
	"+": "reject",
});
const turnSchema = type({
	msgId: "string",
	question: "string",
	"answer?": "string",
	"error?": "string",
	status: "'queued' | 'running' | 'complete' | 'error' | 'interrupted'",
	createdAt: "number",
	updatedAt: "number",
	"+": "reject",
});
const recordSchema = type({
	threadId: "string",
	kind: "'status' | 'ask' | 'task'",
	peer: peerSchema,
	mainSessionId: "string",
	"forkAgentId?": "string",
	"forkLeafId?": "string | null",
	turns: turnSchema.array(),
	createdAt: "number",
	updatedAt: "number",
	"+": "reject",
});

function isValidMeshThreadId(id: string): boolean {
	return THREAD_ID_RE.test(id);
}

function recordFileName(threadId: string): string {
	// The prefix also prevents Windows device names (CON, NUL, etc.).
	return `entry-${threadId}.json`;
}

function isTurnInFlight(turn: MeshThreadTurn): boolean {
	return turn.status === "queued" || turn.status === "running";
}

/** Whether a turn of `record` still waits for its answer (such a thread never expires or gets evicted). */
function isInFlight(record: MeshThreadRecord): boolean {
	return record.turns.some(isTurnInFlight);
}

function digest(content: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/**
 * Provider lineage key for a status thread's turn at `turnIndex`: successful follow-ups share one;
 * a turn after a failed or interrupted one starts a fresh lineage (the old transport may still be unwinding).
 */
export function meshConversationKey(record: MeshThreadRecord, turnIndex: number): string {
	const epoch = record.turns.slice(0, turnIndex).findLastIndex(turn => turn.status !== "complete") + 1;
	return `mesh:${record.threadId}:${epoch}`;
}

/** Completed question/answer pairs before `turnIndex`, for replay into a fresh context. */
export function meshThreadHistory(record: MeshThreadRecord, turnIndex: number): MeshThreadTurn[] {
	return record.turns.slice(0, turnIndex).filter(turn => turn.status === "complete" && turn.answer !== undefined);
}

/**
 * Follow-up routing for an `ask` thread: continue the existing fork only while it can be resumed and
 * the main session has not moved since it was forked; anything else re-forks the current main head.
 */
export function decideAskRoute(args: {
	forkAgentId?: string;
	forkLeafId?: string | null;
	mainLeafId: string | null;
	forkResumable: boolean;
}): "continue" | "fork" {
	if (args.forkAgentId === undefined || args.forkLeafId === undefined || !args.forkResumable) return "fork";
	return args.mainLeafId === args.forkLeafId ? "continue" : "fork";
}

export class MeshThreadStore {
	readonly #host: MeshThreadHost;
	readonly #ttlMs: () => number;
	readonly #records = new Map<string, MeshThreadRecord>();
	/** Expired thread id -> asking instance id. */
	readonly #expired = new LRUCache<string, string>({ max: MAX_EXPIRED_IDS });
	readonly #revisions = new Map<string, string>();
	/** Latest unwritten content per thread while its write waits in the queue. */
	readonly #queuedContent = new Map<string, { record: MeshThreadRecord; content: string; directory: string }>();
	readonly #turnQueues = new Map<string, Promise<void>>();
	readonly #unsubscribe: () => void;
	#directory: string | undefined;
	#sessionId: string;
	#ready: Promise<void>;
	#writes: Promise<void> = Promise.resolve();

	constructor(host: MeshThreadHost, options: { ttlMs: () => number }) {
		this.#host = host;
		this.#ttlMs = options.ttlMs;
		this.#sessionId = host.getSessionId();
		this.#directory = this.#resolveDirectory();
		this.#ready = this.#load(this.#directory);
		this.#unsubscribe = host.registerSessionChangeCallback(() => this.#onSessionChanged());
	}

	dispose(): void {
		this.#unsubscribe();
	}

	/** Resolve `threadId` for `askerInstanceId`; foreign threads are indistinguishable from unknown ones. */
	async lookup(threadId: string, askerInstanceId: string): Promise<MeshThreadLookup> {
		await this.#ready;
		const record = this.#records.get(threadId);
		if (record?.peer.instanceId === askerInstanceId) {
			if (!this.#isStale(record)) return { ok: true, record };
			this.#expire(record, true);
		}
		if (this.#expired.peek(threadId) === askerInstanceId) {
			return { ok: false, code: "thread_expired", message: `Thread ${threadId} expired.` };
		}
		return { ok: false, code: "unknown_thread", message: `Unknown thread ${threadId}.` };
	}

	/** Whether `record` is still this store's thread (not expired by TTL or a session switch). */
	isLive(record: MeshThreadRecord): boolean {
		return this.#records.get(record.threadId) === record;
	}
	/** Threads asked by `askerInstanceId`, newest first. */
	async list(askerInstanceId: string): Promise<MeshThreadRecord[]> {
		await this.#ready;
		this.#sweep();
		return Array.from(this.#records.values())
			.filter(record => record.peer.instanceId === askerInstanceId)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/**
	 * Start a thread with its first question (status `queued`).
	 * @throws {MeshThreadLimitError} `busy` when too many questions are unanswered; nothing is created.
	 */
	async create(kind: MeshThreadKind, peer: MeshSender, msgId: string, question: string): Promise<MeshThreadRecord> {
		await this.#ready;
		this.#sweep();
		// No await between this check and the insert below: concurrent arrivals cannot slip past the cap.
		this.#admit(peer.instanceId);
		this.#makeRoom(peer.instanceId);
		const now = Date.now();
		const record: MeshThreadRecord = {
			threadId: Snowflake.next(),
			kind,
			peer: { instanceId: peer.instanceId, agentId: peer.agentId, displayName: peer.displayName, host: peer.host },
			mainSessionId: this.#sessionId,
			turns: [{ msgId, question, status: "queued", createdAt: now, updatedAt: now }],
			createdAt: now,
			updatedAt: now,
		};
		this.#records.set(record.threadId, record);
		this.#persist(record);
		return record;
	}

	/**
	 * Queue a follow-up question on an existing thread; returns the new turn's index.
	 * @throws {MeshThreadLimitError} `thread_expired` when the thread is no longer live, `bad_request` when it
	 * is full, `busy` when too many questions are unanswered; the record is left unchanged.
	 */
	appendTurn(threadId: string, msgId: string, question: string): number {
		const record = this.#records.get(threadId);
		// A concurrent arrival may have evicted the thread (or a session switch dropped it) since the caller's lookup.
		if (!record) throw new MeshThreadLimitError("thread_expired", `Thread ${threadId} expired.`);
		if (record.turns.length >= MESH_MAX_TURNS_PER_THREAD) {
			throw new MeshThreadLimitError(
				"bad_request",
				`Thread ${threadId} is full (${MESH_MAX_TURNS_PER_THREAD} turns); start a new thread.`,
			);
		}
		this.#admit(record.peer.instanceId);
		const now = Date.now();
		record.turns.push({ msgId, question, status: "queued", createdAt: now, updatedAt: now });
		record.updatedAt = now;
		this.#persist(record);
		return record.turns.length - 1;
	}

	/** Refuse a new unanswered turn from `peerInstanceId` while the per-peer or total cap is reached. */
	#admit(peerInstanceId: string): void {
		let total = 0;
		let own = 0;
		for (const record of this.#records.values()) {
			for (const turn of record.turns) {
				if (!isTurnInFlight(turn)) continue;
				total++;
				if (record.peer.instanceId === peerInstanceId) own++;
			}
		}
		if (own >= MESH_MAX_UNANSWERED_PER_PEER) {
			throw new MeshThreadLimitError(
				"busy",
				"Too many unanswered questions from this instance; wait for an answer.",
			);
		}
		if (total >= MESH_MAX_UNANSWERED_TOTAL) {
			throw new MeshThreadLimitError("busy", "Too many unanswered questions on this instance; try again later.");
		}
	}

	/**
	 * Make room for one more record: past the per-peer or total record cap the oldest records without an
	 * unanswered turn are evicted (files removed). Nothing is evicted unless the cap can be met.
	 * @throws {MeshThreadLimitError} `busy` when every record that would have to go still has a turn in flight.
	 */
	#makeRoom(peerInstanceId: string): void {
		const idle = Array.from(this.#records.values())
			.filter(record => !isInFlight(record))
			.sort((a, b) => a.updatedAt - b.updatedAt);
		let own = 0;
		for (const record of this.#records.values()) if (record.peer.instanceId === peerInstanceId) own++;
		const evict = new Set<MeshThreadRecord>();
		for (const record of idle) {
			if (own - evict.size < MESH_MAX_THREADS_PER_PEER) break;
			if (record.peer.instanceId === peerInstanceId) evict.add(record);
		}
		if (own - evict.size >= MESH_MAX_THREADS_PER_PEER) {
			throw new MeshThreadLimitError("busy", "Too many threads from this instance; wait for answers.");
		}
		for (const record of idle) {
			if (this.#records.size - evict.size < MESH_MAX_THREADS_TOTAL) break;
			evict.add(record);
		}
		if (this.#records.size - evict.size >= MESH_MAX_THREADS_TOTAL) {
			throw new MeshThreadLimitError("busy", "Too many threads on this instance; try again later.");
		}
		for (const record of evict) this.#expire(record, true);
	}

	/** Patch a turn; a no-op once the thread expired (session switch / TTL). */
	updateTurn(threadId: string, turnIndex: number, patch: Partial<Omit<MeshThreadTurn, "msgId" | "createdAt">>): void {
		const record = this.#records.get(threadId);
		const turn = record?.turns[turnIndex];
		if (!record || !turn) return;
		const now = Date.now();
		Object.assign(turn, patch, { updatedAt: now });
		record.updatedAt = now;
		this.#persist(record);
	}

	/** Record the responder kept for follow-ups; a no-op once the thread expired. */
	setResponder(threadId: string, responder: { forkAgentId?: string; forkLeafId?: string | null }): void {
		const record = this.#records.get(threadId);
		if (!record) return;
		if (responder.forkAgentId === undefined) delete record.forkAgentId;
		else record.forkAgentId = responder.forkAgentId;
		if (responder.forkLeafId === undefined) delete record.forkLeafId;
		else record.forkLeafId = responder.forkLeafId;
		this.#persist(record);
	}

	/**
	 * Run `work` after every turn queued earlier on `threadId` settled: one running turn per thread,
	 * follow-ups in arrival order. A failed turn does not block the next.
	 */
	runSerialized<T>(threadId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#turnQueues.get(threadId) ?? Promise.resolve();
		const run = previous.then(work);
		const tail = run.then(
			() => {},
			() => {},
		);
		this.#turnQueues.set(threadId, tail);
		void tail.then(() => {
			if (this.#turnQueues.get(threadId) === tail) this.#turnQueues.delete(threadId);
		});
		return run;
	}

	/** Settle queued disk writes. */
	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.#writes;
			await pending;
		} while (pending !== this.#writes);
	}

	#resolveDirectory(): string | undefined {
		const artifactsDir = this.#host.getArtifactsDir();
		return artifactsDir === null ? undefined : path.join(artifactsDir, MESH_THREADS_DIRNAME);
	}

	#onSessionChanged(): void {
		for (const record of this.#records.values()) this.#expire(record, false);
		this.#revisions.clear();
		this.#sessionId = this.#host.getSessionId();
		this.#directory = this.#resolveDirectory();
		this.#ready = this.#load(this.#directory);
	}

	#isStale(record: MeshThreadRecord): boolean {
		const busy = isInFlight(record);
		return !busy && Date.now() - record.updatedAt > this.#ttlMs();
	}

	#sweep(): void {
		for (const record of this.#records.values()) {
			if (this.#isStale(record)) this.#expire(record, true);
		}
	}

	/** Forget `record`; `removeFile` for TTL expiry (a switched-away session keeps its files for a resume). */
	#expire(record: MeshThreadRecord, removeFile: boolean): void {
		this.#records.delete(record.threadId);
		this.#revisions.delete(record.threadId);
		this.#expired.set(record.threadId, record.peer.instanceId);
		const directory = this.#directory;
		if (!removeFile || directory === undefined) return;
		const filePath = path.join(directory, recordFileName(record.threadId));
		this.#enqueueWrite(() => fs.rm(filePath, { force: true }));
	}

	async #load(directory: string | undefined): Promise<void> {
		if (directory === undefined) return;
		let names: string[];
		try {
			names = await fs.readdir(directory);
		} catch (error) {
			if (!isEnoent(error))
				logger.warn("mesh: thread directory unreadable", { directory, error: toError(error).message });
			return;
		}
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			// A switch during the scan owns the store now.
			if (this.#directory !== directory) return;
			const filePath = path.join(directory, name);
			try {
				const stat = await fs.lstat(filePath);
				if (!stat.isFile()) continue;
				const bytes = await fs.readFile(filePath);
				const parsed = recordSchema(JSON.parse(bytes.toString("utf8")));
				if (parsed instanceof type.errors) throw new Error(parsed.summary);
				if (!isValidMeshThreadId(parsed.threadId) || name !== recordFileName(parsed.threadId)) {
					throw new Error("Record id does not match its filename");
				}
				if (parsed.mainSessionId !== this.#sessionId || this.#records.has(parsed.threadId)) continue;
				// The previous process died mid-turn; nobody answers those questions any more.
				const record: MeshThreadRecord = {
					...parsed,
					turns: parsed.turns.map(turn =>
						turn.status === "queued" || turn.status === "running" ? { ...turn, status: "interrupted" } : turn,
					),
				};
				this.#revisions.set(record.threadId, digest(bytes));
				if (this.#isStale(record)) {
					this.#expire(record, true);
					continue;
				}
				this.#records.set(record.threadId, record);
			} catch (error) {
				logger.warn("mesh: ignoring unreadable thread record", { path: filePath, error: toError(error).message });
			}
		}
	}

	#persist(record: MeshThreadRecord): void {
		const directory = this.#directory;
		if (directory === undefined) return;
		// Snapshot now: the record keeps changing while the write waits in the queue. Turn updates that
		// land while a write for this thread is still queued replace its content instead of queuing another.
		const threadId = record.threadId;
		const content = `${JSON.stringify(record)}\n`;
		const queued = this.#queuedContent.get(threadId);
		if (queued?.directory === directory) {
			queued.record = record;
			queued.content = content;
			return;
		}
		const entry = { record, content, directory };
		this.#queuedContent.set(threadId, entry);
		this.#enqueueWrite(async () => {
			if (this.#queuedContent.get(threadId) === entry) this.#queuedContent.delete(threadId);
			// Expired or switched away while queued: the file belongs to nobody now.
			if (this.#records.get(threadId) !== entry.record || this.#directory !== directory) return;
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			const filePath = path.join(directory, recordFileName(threadId));
			let current: string | undefined;
			try {
				current = digest(await fs.readFile(filePath));
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			if (current !== this.#revisions.get(threadId)) {
				throw new Error(`Thread ${threadId} was changed on disk by another writer; keeping it in memory only.`);
			}
			const written = entry.content;
			await writeFileAtomically(filePath, written);
			this.#revisions.set(threadId, digest(written));
		});
	}

	#enqueueWrite(write: () => Promise<unknown>): void {
		this.#writes = this.#writes.then(write).then(
			() => {},
			error => {
				logger.warn("mesh: thread record write failed", { error: toError(error).message });
			},
		);
	}
}
