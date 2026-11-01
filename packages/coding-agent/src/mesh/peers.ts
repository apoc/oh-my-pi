/**
 * Peer addressing and plain-text peer listings shared by the mesh tools and `mesh://`. Every
 * peer-supplied string is harness-tag escaped: listings land in the agent's context.
 */
import { formatAge, truncate } from "@oh-my-pi/pi-utils";
import type { MeshEngine, MeshPeerView } from "./engine";
import { meshPeerText } from "./text";
import type { MeshSnapshot } from "./wire";

type MeshPeerResolution = { ok: true; peer: MeshPeerView } | { ok: false; message: string };

/** How long a freshly started engine needs before its peer list means "these are all the peers". */
export const MESH_DISCOVERY_WINDOW_MS = 2500;

/**
 * Whether a peer shows up in listings and resolves as a `to`: not hidden by the user and verified
 * by a snapshot (a peer without one is unverified or transient, e.g. a short-lived `omp mesh list`).
 */
export function isListedMeshPeer(peer: MeshPeerView): boolean {
	return !peer.hidden && peer.snapshot !== null;
}

/** Listed peers ({@link isListedMeshPeer}), in engine order. */
export function visibleMeshPeers(engine: Pick<MeshEngine, "peers">): MeshPeerView[] {
	return engine.peers().filter(isListedMeshPeer);
}

/** `displayName (instanceId)`, or the bare id before the first snapshot; harness-tag escaped. */
export function meshPeerLabel(peer: MeshPeerView): string {
	const name = peer.snapshot?.displayName;
	return meshPeerText(name ? `${name} (${peer.instanceId})` : peer.instanceId);
}

/** `local`, or `remote <ip> · <dns name | hostname>`. */
export function formatMeshEndpoint(peer: MeshPeerView): string {
	const endpoint = peer.endpoint;
	if (endpoint.kind === "local") return "local";
	const name = endpoint.dnsName ?? endpoint.hostname;
	return name ? `remote ${endpoint.address} · ${name}` : `remote ${endpoint.address}`;
}

/**
 * Resolve a `to` argument: exact instance id first (hidden peers included); otherwise the peers
 * whose display or session name equals it (case-insensitive) together with those whose instance id
 * starts with it must be exactly one peer. A name and a different peer's id prefix are ambiguous,
 * so a peer cannot capture name-addressed sends by choosing a look-alike id. Peers without a
 * snapshot never resolve.
 */
export function resolveMeshPeer(peers: readonly MeshPeerView[], to: string): MeshPeerResolution {
	const query = to.trim();
	if (query.length === 0) return { ok: false, message: "`to` is empty." };
	const verified = peers.filter(peer => peer.snapshot !== null);
	const exact = verified.find(peer => peer.instanceId === query);
	if (exact) return { ok: true, peer: exact };

	const listed = verified.filter(peer => !peer.hidden);
	const lower = query.toLowerCase();
	const matches = listed.filter(
		peer =>
			peer.snapshot?.displayName.toLowerCase() === lower ||
			peer.snapshot?.sessionName?.toLowerCase() === lower ||
			peer.instanceId.toLowerCase().startsWith(lower),
	);
	if (matches.length === 1) return { ok: true, peer: matches[0]! };
	const escaped = meshPeerText(query);
	if (matches.length > 1) {
		return {
			ok: false,
			message: `"${escaped}" matches several peers by name or instance id prefix: ${matches.map(meshPeerLabel).join(", ")}. Use the full instance id.`,
		};
	}
	const known = listed.length > 0 ? ` Known peers: ${listed.map(meshPeerLabel).join(", ")}.` : " No peers are known.";
	return { ok: false, message: `No mesh peer matches "${escaped}".${known}` };
}

function flag(label: string, value: string | null | undefined): string | undefined {
	return value ? `${label}: ${meshPeerText(value)}` : undefined;
}

/** The branch a peer works on, or its short head commit when detached. */
function branchOf(snapshot: MeshSnapshot): string | undefined {
	return snapshot.repo?.branch ?? snapshot.repo?.head?.slice(0, 12);
}

/** A compact multi-line description of one peer. */
export function formatMeshPeer(peer: MeshPeerView, now: number = Date.now()): string {
	const snapshot = peer.snapshot;
	const states: string[] = [peer.state];
	if (snapshot) states.push(snapshot.busy ? "busy" : "idle");
	if (peer.blocked) states.push("blocked");
	const name = snapshot ? meshPeerText(snapshot.displayName) : "(no snapshot yet)";
	const lines = [`${meshPeerText(peer.instanceId)} · ${name} [${states.join(", ")}]`];
	const seen = formatAge(Math.max(0, now - peer.lastSeen) / 1000) || "just now";
	lines.push(
		[flag("session", snapshot?.sessionName), `endpoint: ${meshPeerText(formatMeshEndpoint(peer))}`, `seen ${seen}`]
			.filter(Boolean)
			.join(" · "),
	);
	if (snapshot) {
		lines.push(
			[
				flag("cwd", snapshot.cwd),
				flag("branch", branchOf(snapshot)),
				flag("model", snapshot.model),
				`agents: ${snapshot.agents.length}`,
			]
				.filter(Boolean)
				.join(" · "),
		);
		if (snapshot.summary) lines.push(`summary: ${meshPeerText(snapshot.summary.text)}`);
	}
	return lines.map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
}

/** Summary characters a {@link meshPeerBrief} keeps: notices list many peers at once. */
const BRIEF_SUMMARY_CHARS = 150;

/** One peer for agent notices: label, session, state, cwd and branch, then a short summary line. */
export function meshPeerBrief(peer: MeshPeerView): string {
	const snapshot = peer.snapshot;
	const states = [snapshot?.busy ? "busy" : "idle"];
	if (peer.state === "stale") states.push("stale");
	if (peer.blocked) states.push("blocked");
	const line = [
		`${meshPeerLabel(peer)} [${states.join(", ")}]`,
		flag("session", snapshot?.sessionName),
		flag("cwd", snapshot?.cwd),
		flag("branch", snapshot && branchOf(snapshot)),
	]
		.filter(Boolean)
		.join(" · ");
	const summary = snapshot?.summary?.text;
	return summary ? `${line}\n  summary: ${meshPeerText(truncate(summary, BRIEF_SUMMARY_CHARS))}` : line;
}

/** Every listed peer ({@link isListedMeshPeer}), one block each; `mesh_peers` without a query and `mesh://`. */
export function formatMeshPeerList(peers: readonly MeshPeerView[], now: number = Date.now()): string {
	const visible = peers.filter(isListedMeshPeer);
	if (visible.length === 0) return "No mesh peers found.";
	const header = `${visible.length} mesh ${visible.length === 1 ? "peer" : "peers"}:`;
	return [header, ...visible.map(peer => formatMeshPeer(peer, now))].join("\n\n");
}
