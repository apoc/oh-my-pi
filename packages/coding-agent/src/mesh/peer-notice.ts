/**
 * Mesh peer awareness for the bound main session, carried by a hidden `mesh:peers` notice. The
 * first one lists every agent on the mesh (or says there is none); after that, agents that appear
 * or leave are announced. Notices ride a user prompt or go between a tool batch and the next model
 * call — never at a stop boundary, so a notice never costs a turn or wakes an idle agent. What the
 * agent already knows is replayed from the notices still in its context, so resume, compaction,
 * `/new` and session switches need no state of their own.
 *
 * Nothing is said until a freshly started engine had {@link MESH_DISCOVERY_WINDOW_MS} to discover
 * peers: before that, an empty list means "not found yet", not "gone". Departures then follow
 * discovery: a local instance leaves as soon as its registry entry goes, a remote one only after the
 * engine's stale sweep, so a brief network blip announces nothing.
 */
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import meshPeersNoticeTemplate from "../prompts/system/mesh-peers-notice.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import { MESH_DISCOVERY_WINDOW_MS, isListedMeshPeer, meshPeerBrief } from "./peers";
import { getMeshRuntime } from "./runtime";
import { cfgMeshAnnouncePeers } from "./settings";
import { meshPeerText } from "./text";
import { meshToolRefs } from "./tool-refs";

export const MESH_PEERS_NOTICE_TYPE = "mesh:peers";

/** Peers a notice describes in full; the rest are counted and left to `mesh_peers`. */
const MAX_DESCRIBED_PEERS = 12;

/** One {@link MESH_PEERS_NOTICE_TYPE} notice: peers announced as present (raw display names) and gone (ids). */
export interface MeshPeersNoticeDetails {
	added: { id: string; name: string }[];
	removed: string[];
}

/**
 * Where the notice goes: `prompt` (with a user prompt) or `work` (mid-run after a tool batch,
 * where the model reads it before its next call).
 */
export type MeshPeersNoticeBoundary = "prompt" | "work";

/** Announced peers still present (id → display name); `undefined` when the context holds no notice yet. */
function knownMeshPeers(session: AgentSession): Map<string, string> | undefined {
	let known: Map<string, string> | undefined;
	for (const message of session.messages) {
		if (message.role !== "custom" || message.customType !== MESH_PEERS_NOTICE_TYPE) continue;
		const details = message.details;
		if (!isRecord(details) || !Array.isArray(details.added) || !Array.isArray(details.removed)) continue;
		known ??= new Map();
		for (const peer of details.added) {
			if (isRecord(peer) && typeof peer.id === "string" && typeof peer.name === "string") {
				known.set(peer.id, peer.name);
			}
		}
		for (const id of details.removed) if (typeof id === "string") known.delete(id);
	}
	return known;
}

/**
 * The notice reconciling what `session` knows about mesh peers with the live list, or `undefined`
 * when nothing needs saying. Only the session the mesh is bound to gets one, and nothing is said
 * while the mesh is off: a stopped mesh is not every agent leaving.
 */
export function takeMeshPeersNotice(
	session: AgentSession,
	boundary: MeshPeersNoticeBoundary,
): CustomMessage<MeshPeersNoticeDetails> | undefined {
	const runtime = getMeshRuntime();
	if (runtime?.session !== session || !cfgMeshAnnouncePeers.get(session.settings)) return undefined;
	if (Date.now() - runtime.identity.startedAt < MESH_DISCOVERY_WINDOW_MS) return undefined;
	const known = knownMeshPeers(session);
	const peers = runtime.engine.peers();
	const live = peers.filter(isListedMeshPeer);
	const added = known ? live.filter(peer => !known.has(peer.instanceId)) : live;
	// A peer the user hid is still there (and still reachable by id): hiding it is no departure.
	const present = new Set(peers.flatMap(peer => (peer.snapshot ? [peer.instanceId] : [])));
	const removed = known ? [...known].filter(([id]) => !present.has(id)) : [];
	const roster = known === undefined;
	if (!roster && added.length === 0 && removed.length === 0) return undefined;

	const described = added.slice(0, MAX_DESCRIBED_PEERS);
	return {
		role: "custom",
		customType: MESH_PEERS_NOTICE_TYPE,
		content: prompt.render(meshPeersNoticeTemplate, {
			roster,
			midRun: boundary === "work",
			added: described.map(meshPeerBrief),
			more: added.length - described.length,
			removed: removed.map(([id, name]) => meshPeerText(`${name} (${id})`)),
			toolRefs: meshToolRefs(session.toolSession ?? {}),
		}),
		details: {
			added: added.map(peer => ({ id: peer.instanceId, name: peer.snapshot?.displayName ?? peer.instanceId })),
			removed: removed.map(([id]) => id),
		},
		attribution: "agent",
		display: false,
		timestamp: Date.now(),
	};
}
