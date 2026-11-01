/**
 * Relevance ranking of mesh peers for `mesh_peers {query}`: per peer, one yes/no judge question
 * (is this the instance to contact?) whose probability is the score, plus one choice question
 * naming the field that connects it, which becomes the one-line reason.
 */
import {
	type ChoiceQuestion,
	type Judge,
	type JsonValue,
	judgeQuestions,
	type NoulQuestion,
	renderQuestion,
} from "@oh-my-pi/pi-ai";
import { truncate } from "@oh-my-pi/pi-utils";
import questionFile from "../prompts/judge/mesh.json" with { type: "json" };
import type { MeshPeerView } from "./engine";

const QUESTIONS = judgeQuestions(questionFile);

/** Peers sent to the judge; the rest of a larger mesh stays unranked. */
export const MAX_RANKED_PEERS = 32;
/** Longest peer field shown to the judge, ellipsis included. */
const FIELD_CHARS = 401;

type MeshMatchField = keyof typeof QUESTIONS.match.criteria;

export interface RankedMeshPeer {
	peer: MeshPeerView;
	/** Probability the peer serves the need, 0–1. */
	score: number;
	/** Field that connects the peer to the need. */
	match: MeshMatchField;
}

function clip(text: string | null | undefined): string | null {
	return text ? truncate(text, FIELD_CHARS) : null;
}

function judgeView(peer: MeshPeerView): { [key: string]: JsonValue } {
	const snapshot = peer.snapshot;
	if (!snapshot) return { name: null, note: "no snapshot yet" };
	return {
		name: clip(snapshot.displayName),
		session: clip(snapshot.sessionName),
		summary: clip(snapshot.summary?.text),
		cwd: clip(snapshot.cwd),
		repo: snapshot.repo ? { remote: clip(snapshot.repo.remote), branch: clip(snapshot.repo.branch) } : null,
		agents: snapshot.agents.slice(0, 8).map(agent => ({
			name: clip(agent.displayName),
			status: agent.status,
			task: clip(agent.task),
		})),
		busy: snapshot.busy,
	};
}

/** The text of `field` on `peer`, for the reason line; `undefined` when it has none. */
export function meshMatchText(peer: MeshPeerView, field: MeshMatchField): string | undefined {
	const snapshot = peer.snapshot;
	if (!snapshot) return undefined;
	switch (field) {
		case "summary":
			return snapshot.summary?.text;
		case "repo":
			return [snapshot.repo?.remote, snapshot.repo?.branch].filter(Boolean).join(" @ ") || undefined;
		case "cwd":
			return snapshot.cwd;
		case "session":
			return snapshot.sessionName ?? undefined;
		case "agents":
			return (
				snapshot.agents
					.map(agent => (agent.task ? `${agent.displayName}: ${agent.task}` : agent.displayName))
					.join("; ") || undefined
			);
		case "none":
			return undefined;
	}
}

/** Rank up to {@link MAX_RANKED_PEERS} peers by relevance to `need`, best first. Judge failures propagate. */
export async function rankMeshPeers(
	judge: Judge,
	need: string,
	peers: readonly MeshPeerView[],
	signal?: AbortSignal,
): Promise<RankedMeshPeer[]> {
	const ranked = peers.slice(0, MAX_RANKED_PEERS);
	if (ranked.length === 0) return [];
	const views: { [key: string]: JsonValue } = {};
	const questions: Record<string, NoulQuestion | ChoiceQuestion<MeshMatchField>> = {};
	ranked.forEach((peer, index) => {
		const key = `p${index}`;
		views[key] = judgeView(peer);
		questions[`r${index}`] = renderQuestion(QUESTIONS.relevant, { key });
		questions[`m${index}`] = renderQuestion(QUESTIONS.match, { key });
	});
	const { answers } = await judge.judge({ state: { need, peers: views }, questions }, { signal });
	return ranked
		.map((peer, index) => {
			const relevant = answers[`r${index}`];
			const match = answers[`m${index}`];
			return {
				peer,
				score: relevant?.type === "noul" ? relevant.noul : 0,
				match: match?.type === "choice" ? match.choice : "none",
			};
		})
		.sort((a, b) => b.score - a.score);
}
