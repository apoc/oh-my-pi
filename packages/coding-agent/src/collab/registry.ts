/**
 * Local Collab host registry.
 *
 * A connected Collab host serves the `collab` namespace on this process's
 * same-machine instance (see {@link sharedInstanceHost}): one owner-only entry
 * in `~/.omp/run/instances` and one private IPC endpoint (Unix domain socket on
 * POSIX, named pipe on Windows), shared with the mesh. A separate local process
 * can discover live hosts and, on explicit request, retrieve a shareable URL:
 *
 * - `snapshot`: non-capability metadata (identity, session, cwd, model,
 *   participants, relay/attention/activity state) suitable for listing and
 *   polling;
 * - `link`: one browser URL for one exact host generation and access level,
 *   rejected when the generation moved or the access level is not published.
 *
 * The registry engine (endpoint, authentication, listing, pruning, link
 * resolution) is native (`pi_instances::collab`); this module adapts host state
 * to it. Full-control and view-only URLs, room keys, and write tokens stay in
 * host memory and never touch the disk. Guests never publish.
 */
import {
	type CollabHostQuery,
	type CollabHostSnapshot,
	type CollabRegistration,
	type CollabResolvedLink,
	type InstanceHost,
	listCollabHosts as nativeListCollabHosts,
	resolveCollabHostLink as nativeResolveCollabHostLink,
	publishCollab,
} from "@oh-my-pi/pi-natives";
import { instanceRegistryDir, sharedInstanceHost } from "../instances";

export type { CollabHostSnapshot, CollabResolvedLink };

/** Version of the `omp collab list --json` / `omp collab link --json` output. */
export const COLLAB_REGISTRY_VERSION = 1;

/** Access a link grants: `view` (bare room key) or `control` (room key + write token). */
export type CollabAccess = CollabHostSnapshot["access"];

/** Live host state served to local listers. */
export interface CollabHostRegistrySource {
	/** Current metadata; throws when the host can no longer vouch for its session. */
	snapshot(): CollabHostSnapshot;
	/** Browser URL for `access`, or `null` when that access is not published. */
	link(access: CollabAccess): string | null;
}

/** Handle returned by {@link publishCollabHost}; closing withdraws the host. */
export interface CollabHostPublication {
	/** Stop serving the `collab` namespace (the instance host stays open). Idempotent. */
	close(): Promise<void>;
}

export interface CollabPublishOptions {
	/** Instance to serve on; defaults to {@link sharedInstanceHost}. Its id is the collab instance id. */
	host?: InstanceHost;
}

export interface CollabListOptions {
	/** Registry directory; defaults to {@link instanceRegistryDir}. */
	dir?: string;
	/** Per-host query deadline in milliseconds. */
	timeoutMs?: number;
}

/** Stable failure codes for {@link resolveCollabHostLink}; never carry URLs. */
export type CollabLinkErrorCode = "not_found" | "ambiguous" | "stale_generation" | "access_unavailable" | "unreachable";

const LINK_ERROR_CODES: Record<CollabLinkErrorCode, true> = {
	not_found: true,
	ambiguous: true,
	stale_generation: true,
	access_unavailable: true,
	unreachable: true,
};

function isLinkErrorCode(code: unknown): code is CollabLinkErrorCode {
	return typeof code === "string" && Object.hasOwn(LINK_ERROR_CODES, code);
}

export class CollabLinkError extends Error {
	readonly code: CollabLinkErrorCode;
	constructor(code: CollabLinkErrorCode, message: string) {
		super(message);
		this.name = "CollabLinkError";
		this.code = code;
	}
}

/**
 * Publish a live Collab host to the local registry.
 *
 * Serves `source` under the `collab` namespace of `options.host` (binding its
 * endpoint and writing its entry on first use). Each query reads the snapshot
 * and, for a link, the URL in one synchronous tick, so a URL always belongs to
 * the generation it is answered with. Call {@link CollabHostPublication.close}
 * on every teardown path; the instance host withdraws its entry on exit.
 */
export async function publishCollabHost(
	source: CollabHostRegistrySource,
	options?: CollabPublishOptions,
): Promise<CollabHostPublication> {
	const host = options?.host ?? sharedInstanceHost();
	const answer = (registration: CollabRegistration, { requestId, op, access }: CollabHostQuery): void => {
		try {
			// One tick: the URL always belongs to the snapshot it is answered with.
			const snapshot = source.snapshot();
			const url = op === "link" && access !== undefined ? source.link(access) : null;
			registration.respond(requestId, { snapshot, url });
		} catch {
			// Never let source errors (or URLs) leak: the host answers `snapshot_unavailable`.
			registration.respond(requestId, null);
		}
	};
	// Queries delivered before `publishCollab` resolved (another process listed
	// the entry the moment it was written) wait for the handle.
	const early: CollabHostQuery[] = [];
	let onQuery = (query: CollabHostQuery): void => {
		early.push(query);
	};
	const published = await publishCollab(host, query => onQuery(query));
	onQuery = query => answer(published, query);
	for (const query of early.splice(0)) answer(published, query);
	// Every close awaits the same withdrawal.
	let closing: Promise<void> | undefined;
	return { close: () => (closing ??= published.close()) };
}

function linkError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	const code = (error as Error & { code?: unknown }).code;
	return isLinkErrorCode(code) ? new CollabLinkError(code, error.message) : error;
}

/**
 * List live Collab hosts under this config root.
 *
 * Queries every entry serving `collab` concurrently (bounded, short independent
 * deadlines), prunes dead or malformed entries best-effort, and returns healthy
 * hosts sorted by start time, PID, then instance ID. Unreachable,
 * unauthenticated, malformed, or version-mismatched entries are omitted
 * without failing the listing. The result carries no URLs.
 */
export function listCollabHosts(options?: CollabListOptions): Promise<CollabHostSnapshot[]> {
	return nativeListCollabHosts({ dir: options?.dir ?? instanceRegistryDir(), timeoutMs: options?.timeoutMs });
}

/**
 * Resolve one browser URL for the host selected by `selector` — an exact
 * instance ID, or a PID when no instance matches. The link request carries the
 * generation observed while listing, so a host that rotated rooms in between
 * answers `stale_generation` instead of leaking its successor's capability.
 * Rejects with {@link CollabLinkError}.
 */
export async function resolveCollabHostLink(
	selector: string,
	access: CollabAccess,
	options?: CollabListOptions,
): Promise<CollabResolvedLink> {
	try {
		return await nativeResolveCollabHostLink(selector, access, {
			dir: options?.dir ?? instanceRegistryDir(),
			timeoutMs: options?.timeoutMs,
		});
	} catch (error) {
		throw linkError(error);
	}
}
