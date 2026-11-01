/**
 * Protocol handler for `mesh://` URLs: read-only views of the mesh peers of this process.
 *
 * - `mesh://` - visible peers (same listing as `mesh_peers` without a query)
 * - `mesh://<peer>` - that peer's full snapshot and endpoint facts
 * - `mesh://<peer>/threads` - threads this instance asked that peer
 * - `mesh://<peer>/threads/<id>` - one thread's question/answer transcript
 *
 * `<peer>` resolves like `mesh_send`'s `to`, but only to a peer with a snapshot (never an unlisted
 * id). Thread views are fetched from the peer, which only
 * shows threads this instance asked. Only the top-level session the mesh serves can read `mesh://`.
 */
import { isRecord, toError } from "@oh-my-pi/pi-utils";
import { meshDisplayText } from "@oh-my-pi/pi-tui/overlays/mesh-display";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { MeshEngineError, type MeshPeerView } from "../mesh/engine";
import {
	formatMeshEndpoint,
	formatMeshPeerList,
	meshPeerLabel,
	resolveMeshPeer,
	visibleMeshPeers,
} from "../mesh/peers";
import { getMeshRuntime } from "../mesh/runtime";
import { cfgMeshEnabled } from "../mesh/settings";
import { isMeshToolSession, requireMeshRuntime } from "../mesh/tool-refs";
import type { MeshRequest, MeshResponse } from "../mesh/wire";
import meshPromptDoc from "../prompts/internal-urls/mesh.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { meshPeerText } from "../mesh/text";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	UrlCompletion,
} from "./types";

/** Transport budget for a thread fetch. */
const FETCH_TIMEOUT_MS = 15_000;

function formatTime(ms: unknown): string {
	return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "?";
}

function text(value: unknown): string {
	return typeof value === "string" ? meshPeerText(value) : "";
}

function markdown(url: string, content: string): InternalResource {
	return { url, content, contentType: "text/markdown", size: Buffer.byteLength(content, "utf-8") };
}

/** Peer facts plus its snapshot, as pretty JSON. */
function renderSnapshot(peer: MeshPeerView): string {
	const view = {
		instanceId: peer.instanceId,
		endpoint: formatMeshEndpoint(peer),
		source: peer.source,
		state: peer.state,
		lastSeen: formatTime(peer.lastSeen),
		hidden: peer.hidden,
		blocked: peer.blocked,
		snapshot: peer.snapshot,
	};
	return meshPeerText(JSON.stringify(view, null, 2));
}

function renderThreadList(peer: MeshPeerView, data: unknown): string {
	const threads = isRecord(data) && Array.isArray(data.threads) ? data.threads.filter(isRecord) : [];
	const label = meshPeerLabel(peer);
	if (threads.length === 0) return `No threads asked of ${label}.\n`;
	const lines = [`# Threads asked of ${label}`, ""];
	for (const thread of threads) {
		lines.push(
			`- \`${text(thread.thread)}\` ${text(thread.kind)} · ${typeof thread.turns === "number" ? thread.turns : "?"} turns · ${text(thread.status) || "?"} · updated ${formatTime(thread.updatedAt)}`,
		);
	}
	lines.push("", `Read one with mesh://${peer.instanceId}/threads/<id>.`);
	return `${lines.join("\n")}\n`;
}

function renderThread(peer: MeshPeerView, data: unknown): string {
	if (!isRecord(data)) return "Peer returned no thread.\n";
	const turns = Array.isArray(data.turns) ? data.turns.filter(isRecord) : [];
	const lines = [`# Thread ${text(data.thread)} (${text(data.kind)}) with ${meshPeerLabel(peer)}`];
	turns.forEach((turn, index) => {
		lines.push(
			"",
			`## Turn ${index + 1} · ${text(turn.status)} · ${formatTime(turn.createdAt)}`,
			"",
			"**Question**",
			"",
			text(turn.question),
		);
		if (typeof turn.answer === "string") lines.push("", "**Answer**", "", text(turn.answer));
		if (typeof turn.error === "string") lines.push("", `**Error:** ${text(turn.error)}`);
	});
	return `${lines.join("\n")}\n`;
}

/** Read-only mesh peers, snapshots and the threads this instance asked them. */
export class MeshProtocolHandler implements ProtocolHandler {
	readonly scheme = "mesh";
	readonly spec: SchemeSpec = { backing: "remote", selectors: "lines", immutable: true };

	/** Advertised only where the mesh tools exist: `mesh.enabled`, the top-level session the mesh serves. */
	promptDoc(host: SchemeHost): string | undefined {
		return host.mesh ? meshPromptDoc.trim() : undefined;
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const runtime = getMeshRuntime();
		if (!runtime || !context) return [];
		// Tool callers carry their session; the editor autocomplete only the session id.
		const allowed = context.session
			? isMeshToolSession(context.session)
			: context.sessionId !== undefined &&
				cfgMeshEnabled.get(runtime.session.settings) &&
				context.sessionId === runtime.session.sessionManager.getSessionId();
		if (!allowed) return [];
		const engine = runtime.engine;
		// Peer names reach the terminal: one sanitized line each.
		return visibleMeshPeers(engine).map(peer => ({
			value: peer.instanceId,
			label: meshDisplayText(peer.snapshot?.displayName ?? peer.instanceId),
			description: peer.snapshot?.sessionName ? meshDisplayText(peer.snapshot.sessionName) : undefined,
		}));
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const { engine } = requireMeshRuntime(context?.session);
		// `rawHost` is already percent-decoded by the URL parser.
		const target = url.rawHost || url.hostname;
		if (!target) return markdown(url.href, `${formatMeshPeerList(engine.peers())}\n`);

		const resolution = resolveMeshPeer(engine.peers(), target);
		if (!resolution.ok) throw new ToolError(resolution.message);
		const peer = resolution.peer;
		let segments: string[];
		try {
			segments = (url.rawPathname ?? url.pathname).split("/").filter(Boolean).map(decodeURIComponent);
		} catch {
			throw new ToolError(`Invalid URL encoding in mesh:// path: ${meshPeerText(url.href)}`);
		}
		if (segments.length === 0) {
			const content = `${renderSnapshot(peer)}\n`;
			return { url: url.href, content, contentType: "application/json", size: Buffer.byteLength(content, "utf-8") };
		}
		if (segments[0] !== "threads" || segments.length > 2) {
			throw new ToolError(
				`Unknown mesh:// path; use mesh://<peer>, mesh://<peer>/threads or mesh://<peer>/threads/<id>.`,
			);
		}
		const body: MeshRequest = segments[1] === undefined ? { op: "threads" } : { op: "thread", thread: segments[1] };
		const fromAgentId = context?.session?.getAgentId?.() ?? MAIN_AGENT_ID;
		let response: MeshResponse;
		try {
			response = await engine.request(peer.instanceId, fromAgentId, body, {
				timeoutMs: FETCH_TIMEOUT_MS,
				signal: context?.signal,
			});
		} catch (error) {
			const reason = error instanceof MeshEngineError ? error.code : "unreachable";
			throw new ToolError(`${meshPeerLabel(peer)} ${reason}: ${meshPeerText(toError(error).message)}`);
		}
		if (!response.ok) {
			throw new ToolError(`${meshPeerLabel(peer)} refused: ${response.code}: ${meshPeerText(response.message)}`);
		}
		return markdown(
			url.href,
			body.op === "threads" ? renderThreadList(peer, response.data) : renderThread(peer, response.data),
		);
	}
}
