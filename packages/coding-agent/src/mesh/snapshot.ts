/**
 * Build the {@link MeshSnapshot} this instance serves to authenticated peers:
 * identity, session, project/repo, model, run state, agent roster and the
 * latest smol summary, and keep the engine's copy current. Every free-form
 * string is bounded to `MAX_FIELD_CHARS`.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger, VERSION } from "@oh-my-pi/pi-utils";
import { redactUrlForLog } from "../mcp/json-rpc";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { isCurrentSessionRosterRef, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import type { AgentSession } from "../session/agent-session";
import type { MeshEngine } from "./engine";
import type { MeshSummaryGenerator, MeshSummaryState } from "./summary";
import { MAX_FIELD_CHARS, MESH_PROTOCOL_VERSION, type MeshSnapshot } from "./wire";

/** Budget for all repository reads; a slow or hung VCS yields `repo: null`. */
const REPO_TIMEOUT_MS = 1500;
/** Abbreviated commit id length, matching git's default short sha. */
const SHORT_SHA_CHARS = 7;
/** Roster cap so a session with many subagents cannot bloat the snapshot. */
const MAX_AGENTS = 64;
/** Coalesces bursts of triggers (registry churn, turn start/end) into one rebuild. */
const PUBLISH_DEBOUNCE_MS = 250;

export interface MeshIdentity {
	instanceId: string;
	displayName: string;
	host: string;
	startedAt: number;
}

type MeshRepoInfo = NonNullable<MeshSnapshot["repo"]>;

export async function buildMeshSnapshot(
	session: AgentSession,
	ident: MeshIdentity,
	summary: MeshSummaryState | null,
): Promise<MeshSnapshot> {
	const sessionManager = session.sessionManager;
	const cwd = sessionManager.getCwd();
	const model = session.model;
	return {
		instanceId: bound(ident.instanceId),
		displayName: bound(ident.displayName),
		host: bound(ident.host),
		pid: process.pid,
		ompVersion: bound(VERSION),
		protocol: MESH_PROTOCOL_VERSION,
		sessionId: bound(sessionManager.getSessionId()) || null,
		sessionName: bound(sessionManager.getSessionName() ?? "") || null,
		summary: summary ? { text: bound(summary.text), updatedAt: summary.updatedAt } : null,
		cwd: bound(cwd),
		repo: await readRepoInfo(cwd),
		model: model ? bound(`${model.provider}/${model.id}`) : null,
		busy: session.isStreaming,
		agents: listAgents(sessionManager.getSessionFile()),
		startedAt: ident.startedAt,
	};
}

/**
 * Keeps the engine's served snapshot current: rebuilds (debounced) on turn
 * start/end, session switch, model and session-name changes, agent roster
 * changes and summary updates. Out-of-order async builds are dropped.
 */
export class MeshSnapshotPublisher {
	#stop: (() => void) | null = null;

	/** Publish now and on every change until the returned disposer runs; replaces any previous start. */
	start(
		session: AgentSession,
		engine: MeshEngine,
		ident: MeshIdentity,
		summary: Pick<MeshSummaryGenerator, "current" | "onChange">,
	): () => void {
		this.#stop?.();
		let sequence = 0;
		let stopped = false;
		let timer: NodeJS.Timeout | undefined;

		const publish = async () => {
			timer = undefined;
			const seq = ++sequence;
			try {
				const snapshot = await buildMeshSnapshot(session, ident, summary.current);
				if (stopped || seq !== sequence) return;
				engine.setSnapshot(snapshot);
			} catch (error) {
				logger.debug("mesh: snapshot publish failed", { error: String(error) });
			}
		};
		const schedule = () => {
			if (stopped || timer) return;
			timer = setTimeout(publish, PUBLISH_DEBOUNCE_MS);
			timer.unref();
		};

		const disposers = [
			session.subscribe(event => {
				if (event.type === "agent_start" || event.type === "agent_end" || event.type === "model_changed") {
					schedule();
				}
			}),
			session.registerSessionChangeCallback(schedule),
			session.sessionManager.onSessionNameChanged(schedule),
			AgentRegistry.global().onChange(schedule),
			summary.onChange(schedule),
		];
		const stop = () => {
			if (stopped) return;
			stopped = true;
			clearTimeout(timer);
			for (const dispose of disposers) dispose();
			if (this.#stop === stop) this.#stop = null;
		};
		this.#stop = stop;
		void publish();
		return stop;
	}
}

/** Live agents of the current session first, so the cap never hides running work. */
function listAgents(rootSessionFile: string | undefined): MeshSnapshot["agents"] {
	const live: AgentRef[] = [];
	const rest: AgentRef[] = [];
	for (const ref of AgentRegistry.global().list()) {
		// Advisors are passive review transcripts, never peers; killed agents are gone.
		if (ref.kind === "advisor" || ref.status === "aborted") continue;
		// Parked trees of other sessions (after `/new` or a switch) are not this session's agents.
		if (!isCurrentSessionRosterRef(ref, rootSessionFile)) continue;
		// The registry is process-wide: other top-level sessions (ACP) run their own agents.
		if (ref.sessionFile && rootSessionFile && !sessionFileBelongsToRoot(ref.sessionFile, rootSessionFile)) continue;
		(ref.status === "running" || ref.status === "idle" ? live : rest).push(ref);
	}
	return [...live, ...rest].slice(0, MAX_AGENTS).map(ref => ({
		id: bound(ref.id),
		kind: ref.kind,
		displayName: bound(ref.displayName),
		status: ref.status,
		...(ref.activity ? { task: bound(ref.activity) } : {}),
	}));
}

async function readRepoInfo(cwd: string): Promise<MeshRepoInfo | null> {
	const signal = AbortSignal.timeout(REPO_TIMEOUT_MS);
	try {
		const repo = vcs.repo(cwd);
		if (!repo) return null;
		const git = repo.asGit();
		const [branch, head, remote] = git
			? await Promise.all([git.currentBranch(signal), git.headSha(signal), git.remoteUrl("origin", signal)])
			: await Promise.all([repo.label(signal), repo.headId(signal), null]);
		const info: MeshRepoInfo = {};
		if (remote) info.remote = bound(redactUrlForLog(remote));
		if (branch) info.branch = bound(branch);
		if (head) info.head = head.slice(0, SHORT_SHA_CHARS);
		return info;
	} catch (error) {
		logger.debug("mesh: repository info unavailable", { cwd, error: String(error) });
		return null;
	}
}

/** Cap at the wire field limit without leaving a split surrogate pair (the engine rejects lone surrogates). */
function bound(value: string): string {
	return value.slice(0, MAX_FIELD_CHARS).toWellFormed();
}
