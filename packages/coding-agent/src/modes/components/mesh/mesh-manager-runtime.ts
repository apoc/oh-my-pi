/**
 * Adapts the process mesh runtime and the `mesh.*` settings to the `/mesh` manager
 * ({@link MeshManagerRuntime}) and the `mesh` status-line entry.
 */
import type {
	MeshComposeKind,
	MeshManagerApproval,
	MeshManagerPeer,
	MeshManagerRuntime,
	MeshManagerState,
	MeshManagerThread,
	MeshSendOutcome,
} from "@oh-my-pi/pi-tui/overlays/mesh-manager-types";
import { countMeshPeers, meshComposeRefusal, meshModeHasSide } from "@oh-my-pi/pi-tui/overlays/mesh-display";
import { meshDeriveKey } from "@oh-my-pi/pi-natives";
import { logger, toError } from "@oh-my-pi/pi-utils";
import type { ScopeLike } from "../../../config/registry";
import type { MeshPeerView } from "../../../mesh/engine";
import { MESH_USER_AGENT_ID } from "../../../mesh/outbound";
import { formatMeshEndpoint } from "../../../mesh/peers";
import { getMeshRuntime, type MeshRuntime, onMeshRuntimeChanged } from "../../../mesh/runtime";
import { cfgMeshEnabled, cfgMeshKey, cfgMeshMode } from "../../../mesh/settings";
import type { MeshApprovalRequest } from "../../../mesh/approvals";
import type { MeshThreadRecord } from "../../../mesh/threads";

/** Peers that served a snapshot, as the manager shows them; peers without one are unverified or transient. */
export function meshPeerViews(peers: readonly MeshPeerView[]): MeshManagerPeer[] {
	const views: MeshManagerPeer[] = [];
	for (const peer of peers) {
		const snapshot = peer.snapshot;
		if (!snapshot) continue;
		views.push({
			instanceId: peer.instanceId,
			endpointKind: peer.endpoint.kind,
			endpoint: formatMeshEndpoint(peer),
			source: peer.source,
			state: peer.state,
			lastSeen: peer.lastSeen,
			hidden: peer.hidden,
			blocked: peer.blocked,
			displayName: snapshot.displayName,
			host: snapshot.host,
			sessionName: snapshot.sessionName ?? undefined,
			cwd: snapshot.cwd,
			branch: snapshot.repo?.branch,
			model: snapshot.model ?? undefined,
			busy: snapshot.busy,
			summary: snapshot.summary?.text,
			agents: snapshot.agents,
		});
	}
	return views;
}

function approvalToView(request: MeshApprovalRequest): MeshManagerApproval {
	return {
		id: request.id,
		kind: request.kind,
		fromName: request.peer.displayName,
		fromHost: request.peer.host,
		fromAgent: request.peer.agentId,
		fromInstanceId: request.peer.instanceId,
		preview: request.preview,
		expiresAt: request.expiresAt,
	};
}

function threadToView(record: MeshThreadRecord): MeshManagerThread {
	const last = record.turns.at(-1);
	return {
		threadId: record.threadId,
		kind: record.kind,
		turns: record.turns.length,
		status: last?.status ?? "queued",
		lastQuestion: last?.question,
		updatedAt: record.updatedAt,
	};
}

/**
 * Calls `onChange` whenever anything the mesh UI shows may have changed: the `mesh.*` settings
 * it reads, runtime installs/removals, and the current runtime's peers, status and approvals.
 */
export function subscribeMeshChanges(settings: ScopeLike, onChange: () => void): () => void {
	let detachRuntime: (() => void) | undefined;
	const follow = (runtime: MeshRuntime | undefined) => {
		detachRuntime?.();
		detachRuntime = undefined;
		if (runtime) {
			const unsubscribers = [
				runtime.engine.onPeersChanged(onChange),
				runtime.engine.onStatusChanged(onChange),
				runtime.frontend.approvals.onChange(onChange),
			];
			detachRuntime = () => {
				for (const unsubscribe of unsubscribers) unsubscribe();
			};
		}
	};
	follow(getMeshRuntime());
	const unsubscribers = [
		onMeshRuntimeChanged(runtime => {
			follow(runtime);
			onChange();
		}),
		cfgMeshEnabled.listen(settings, onChange),
		cfgMeshMode.listen(settings, onChange),
		cfgMeshKey.listen(settings, onChange),
	];
	return () => {
		detachRuntime?.();
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}

export function createMeshManagerRuntime(settings: ScopeLike): MeshManagerRuntime {
	return {
		getState(): MeshManagerState {
			const runtime = getMeshRuntime();
			const status = runtime?.engine.status();
			return {
				enabled: cfgMeshEnabled.get(settings),
				mode: cfgMeshMode.get(settings),
				hasKey: cfgMeshKey.get(settings).length > 0,
				self:
					runtime && status
						? {
								instanceId: runtime.engine.instanceId,
								displayName: runtime.identity.displayName,
								status: {
									local: status.local,
									remote: status.remote,
									lanPort: status.lanPort,
									error: status.error,
								},
							}
						: undefined,
				peers: runtime ? meshPeerViews(runtime.engine.peers()) : [],
				approvals: runtime ? runtime.frontend.approvals.list().map(approvalToView) : [],
			};
		},
		subscribe: onChange => subscribeMeshChanges(settings, onChange),
		setEnabled(enabled) {
			cfgMeshEnabled.set(settings, enabled);
		},
		setMode(mode) {
			cfgMeshMode.set(settings, mode);
		},
		async setKeyPhrase(phrase) {
			cfgMeshKey.set(settings, await meshDeriveKey(phrase));
		},
		setPeerFlags(instanceId, flags) {
			getMeshRuntime()?.engine.setPeerFlags(instanceId, flags);
		},
		resolveApproval(id, allow) {
			getMeshRuntime()?.frontend.approvals.resolve(id, allow);
		},
		refresh() {
			getMeshRuntime()?.engine.refresh();
		},
		async listThreads(peerInstanceId) {
			const runtime = getMeshRuntime();
			// The store lists newest first, as the manager shows them.
			return runtime ? (await runtime.frontend.threads.list(peerInstanceId)).map(threadToView) : [];
		},
		async send(peerInstanceId: string, kind: MeshComposeKind, text: string): Promise<MeshSendOutcome> {
			const runtime = getMeshRuntime();
			if (!runtime) return { ok: false, message: "the mesh engine is not running" };
			const peer = meshPeerViews(runtime.engine.peers()).find(view => view.instanceId === peerInstanceId);
			if (!peer) return { ok: false, message: "the peer is no longer available" };
			try {
				const result = await runtime.frontend.outbound.send({
					to: peer,
					fromAgentId: MESH_USER_AGENT_ID,
					kind,
					text,
				});
				if (result.ok) return { ok: true, thread: result.thread };
				// The manager names the block in its own terms (its `b` key, or a note).
				return {
					ok: false,
					message: (result.code === "blocked" && meshComposeRefusal(peer, kind)) || result.message,
				};
			} catch (error) {
				return { ok: false, message: toError(error).message };
			}
		},
	};
}

/** `N local · M remote[ · K pending]`, or undefined while the mesh is off or not running. */
export function meshPeerCountsText(settings: ScopeLike, runtime: MeshRuntime | undefined): string | undefined {
	if (!runtime || !cfgMeshEnabled.get(settings)) return undefined;
	const mode = cfgMeshMode.get(settings);
	const counts = countMeshPeers(meshPeerViews(runtime.engine.peers()));
	const parts: string[] = [];
	if (meshModeHasSide(mode, "local")) parts.push(`${counts.local} local`);
	if (meshModeHasSide(mode, "remote")) parts.push(`${counts.remote} remote`);
	const pending = runtime.frontend.approvals.list().length;
	if (pending > 0) parts.push(`${pending} pending`);
	return parts.join(" · ");
}

/** Keeps the `mesh` status-line entry current; returns the detacher. */
export function attachMeshStatusLine(
	settings: ScopeLike,
	setHookStatus: (key: string, text: string | undefined) => void,
): () => void {
	let shown: string | undefined;
	const update = () => {
		let text: string | undefined;
		try {
			const counts = meshPeerCountsText(settings, getMeshRuntime());
			text = counts === undefined ? undefined : `mesh: ${counts}`;
		} catch (error) {
			logger.warn("mesh: status line update failed", { error: toError(error).message });
		}
		if (text === shown) return;
		shown = text;
		setHookStatus("mesh", text);
	};
	update();
	const unsubscribe = subscribeMeshChanges(settings, update);
	return () => {
		unsubscribe();
		if (shown !== undefined) setHookStatus("mesh", undefined);
	};
}
