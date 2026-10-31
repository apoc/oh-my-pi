import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, toError } from "@oh-my-pi/pi-utils";
import { journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import type { MeshEngine, MeshPeerView } from "../mesh/engine";
import { formatMeshPeer, formatMeshPeerList, visibleMeshPeers } from "../mesh/peers";
import { MAX_RANKED_PEERS, meshMatchText, type RankedMeshPeer, rankMeshPeers } from "../mesh/relevance";
import { isMeshToolSession, meshToolRefs, requireMeshRuntime } from "../mesh/tool-refs";
import { meshPeerText } from "../mesh/text";
import meshPeersDescription from "../prompts/tools/mesh-peers.md" with { type: "text" };
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

/** Upper bound on how long `refresh` waits for the peer table to change. */
const REFRESH_WAIT_MS = 1500;
/** Characters of the matching field quoted in a ranked entry's reason. */
const REASON_CHARS = 120;

/** Ask the engine to re-discover, then wait for the first peer-table change, {@link REFRESH_WAIT_MS} at most. */
async function refreshPeers(engine: MeshEngine, signal: AbortSignal | undefined): Promise<void> {
	throwIfAborted(signal);
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = () => resolve();
	const unsubscribe = engine.onPeersChanged(done);
	const timer = setTimeout(done, REFRESH_WAIT_MS);
	signal?.addEventListener("abort", done, { once: true });
	try {
		engine.refresh();
		await promise;
	} finally {
		unsubscribe();
		clearTimeout(timer);
		signal?.removeEventListener("abort", done);
	}
	throwIfAborted(signal);
}

const meshPeersSchema = type({
	"query?": type("string").describe("rank peers by relevance to this need"),
	"refresh?": type("boolean").describe("re-discover peers before listing"),
});

export type MeshPeersParams = typeof meshPeersSchema.infer;

export interface MeshPeersDetails {
	peers: number;
	ranked: boolean;
}

export class MeshPeersTool implements AgentTool<typeof meshPeersSchema, MeshPeersDetails> {
	readonly name = "mesh_peers";
	readonly approval = "read" as const;
	readonly label = "Mesh Peers";
	readonly parameters = meshPeersSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "List other omp instances on the mesh, optionally ranked for a need";
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	get description(): string {
		return prompt.render(meshPeersDescription, { toolRefs: meshToolRefs(this.#session) });
	}

	static createIf(session: ToolSession): MeshPeersTool | null {
		return isMeshToolSession(session) ? new MeshPeersTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: MeshPeersParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<MeshPeersDetails>> {
		const { engine } = requireMeshRuntime(this.#session);
		if (params.refresh) await refreshPeers(engine, signal);
		const peers = visibleMeshPeers(engine);
		const query = params.query?.trim();
		if (!query || peers.length === 0) {
			return {
				content: [{ type: "text", text: formatMeshPeerList(peers) }],
				details: { peers: peers.length, ranked: false },
			};
		}
		let ranked: RankedMeshPeer[];
		try {
			ranked = await this.#rank(query, peers, signal);
		} catch (error) {
			throwIfAborted(signal);
			const reason = toError(error).message;
			logger.debug("mesh_peers: ranking failed", { error: reason });
			return {
				content: [
					{
						type: "text",
						text: `Relevance ranking unavailable (${reason}); unranked list:\n\n${formatMeshPeerList(peers)}`,
					},
				],
				details: { peers: peers.length, ranked: false },
			};
		}
		const now = Date.now();
		const blocks = ranked.map(({ peer, score, match }, index) => {
			const text = meshMatchText(peer, match)?.replace(/\s+/g, " ").trim();
			const quote = text
				? `: ${meshPeerText(text.length > REASON_CHARS ? `${text.slice(0, REASON_CHARS)}…` : text)}`
				: "";
			const reason = match === "none" ? "no field connects it to the need" : `matches ${match}${quote}`;
			return `${index + 1}. score ${score.toFixed(2)} — ${reason}\n${formatMeshPeer(peer, now)}`;
		});
		const unranked = peers.length - ranked.length;
		const footer =
			unranked > 0 ? [`${unranked} more peers not ranked (only the first ${MAX_RANKED_PEERS} are judged).`] : [];
		return {
			content: [{ type: "text", text: [`Peers ranked for "${query}":`, ...blocks, ...footer].join("\n\n") }],
			details: { peers: peers.length, ranked: true },
		};
	}

	#rank(query: string, peers: readonly MeshPeerView[], signal: AbortSignal | undefined): Promise<RankedMeshPeer[]> {
		const session = this.#session;
		const registry = session.modelRegistry;
		if (!registry) throw new Error("no model registry to resolve a judge from");
		const judge = resolveJudge({
			settings: session.settings,
			registry,
			sessionId: session.getSessionId?.() ?? undefined,
			purpose: "mesh_peers",
			onUsage: journalJudgmentUsage(session.sessionManager),
			telemetry: session.getTelemetry?.(),
			cache: sharedJudgmentCache(),
			costGate: session.costGate,
		});
		return rankMeshPeers(judge, query, peers, signal);
	}
}
