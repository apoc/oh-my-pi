/**
 * Queue of inbound mesh requests waiting for the user's decision (`mesh.inbound.<kind> = ask`).
 * The TUI renders {@link MeshApprovals.list} and calls {@link MeshApprovals.resolve}; an entry
 * nobody answers is denied when its TTL elapses.
 */
import { logger, Snowflake, toError, truncate } from "@oh-my-pi/pi-utils";
import type { MeshMessageKind, MeshSender } from "./wire";

const MESH_APPROVAL_TTL_MS = 2 * 60 * 1000;
/** Longest approval preview of the request text, ellipsis included. */
const PREVIEW_CHARS = 281;

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
	readonly #pending = new Map<string, PendingApproval>();
	readonly #listeners = new Set<() => void>();
	#snapshot: readonly MeshApprovalRequest[] = [];

	/** Queue a request; resolves `true` when allowed, `false` when denied, expired or disposed. */
	request(peer: MeshSender, kind: MeshMessageKind, text: string): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const id = Snowflake.next();
		const request: MeshApprovalRequest = {
			id,
			peer,
			kind,
			preview: truncate(text, PREVIEW_CHARS),
			expiresAt: Date.now() + MESH_APPROVAL_TTL_MS,
		};
		const timer = setTimeout(() => this.resolve(id, false), MESH_APPROVAL_TTL_MS);
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
		const pending = [...this.#pending.values()];
		if (pending.length === 0) return;
		this.#pending.clear();
		for (const entry of pending) clearTimeout(entry.timer);
		this.#changed();
		for (const entry of pending) entry.resolve(false);
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
