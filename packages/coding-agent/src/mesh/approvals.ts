/**
 * Queue of inbound mesh requests waiting for the user's decision (`mesh.inbound.<kind> = ask`).
 * The TUI renders {@link MeshApprovals.list} and calls {@link MeshApprovals.resolve}; an entry
 * nobody answers is denied when its TTL elapses.
 */
import { logger, Snowflake, toError } from "@oh-my-pi/pi-utils";
import type { MeshMessageKind, MeshSender } from "./wire";

export const MESH_APPROVAL_TTL_MS = 2 * 60 * 1000;
/** Characters of the request text shown in the approval prompt. */
const PREVIEW_CHARS = 280;

export interface MeshApprovalRequest {
	id: string;
	peer: MeshSender;
	kind: MeshMessageKind;
	preview: string;
	expiresAt: number;
}

interface PendingApproval {
	request: MeshApprovalRequest;
	resolve: (allow: boolean) => void;
	timer: NodeJS.Timeout;
}

export class MeshApprovals {
	readonly #ttlMs: number;
	readonly #pending = new Map<string, PendingApproval>();
	readonly #listeners = new Set<() => void>();
	#snapshot: readonly MeshApprovalRequest[] = [];

	constructor(options?: { ttlMs?: number }) {
		this.#ttlMs = options?.ttlMs ?? MESH_APPROVAL_TTL_MS;
	}

	/** Queue a request; resolves `true` when allowed, `false` when denied, expired or disposed. */
	request(peer: MeshSender, kind: MeshMessageKind, text: string): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const id = Snowflake.next();
		const request: MeshApprovalRequest = {
			id,
			peer,
			kind,
			preview: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text,
			expiresAt: Date.now() + this.#ttlMs,
		};
		const timer = setTimeout(() => this.resolve(id, false), this.#ttlMs);
		timer.unref();
		this.#pending.set(id, { request, resolve, timer });
		this.#changed();
		return promise;
	}

	/** Decide one entry; `false` when it already resolved or expired. */
	resolve(id: string, allow: boolean): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(allow);
		this.#changed();
		return true;
	}

	/** Pending entries, oldest first. */
	list(): readonly MeshApprovalRequest[] {
		return this.#snapshot;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Deny every pending entry (frontend detach). */
	denyAll(): void {
		for (const id of this.#pending.keys()) this.resolve(id, false);
	}

	#changed(): void {
		this.#snapshot = Object.freeze(Array.from(this.#pending.values(), entry => entry.request));
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				logger.warn("mesh: approval listener failed", { error: toError(error).message });
			}
		}
	}
}
