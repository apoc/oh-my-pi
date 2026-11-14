/**
 * `/mesh` manager view model: the pure pieces of the fullscreen manager overlay
 * (`ui/overlays/mesh-manager`): sanitizing every state pull, sections and their order, the
 * picker rows Tern draws, the terminal page rows, peer and approval previews, key hints and
 * key-phrase feedback.
 *
 * Peer data is untrusted: {@link sanitizeMeshManagerState} strips ANSI, C0/C1 and bidi controls,
 * newlines (except in summaries) and tabs from every string once per state pull, before anything is
 * styled, measured or sorted. Thread lists ({@link sanitizeMeshThreads}) and notices are sanitized
 * when they arrive.
 */
import { meshPassphraseCheck } from "@oh-my-pi/pi-natives";
import { formatAge, pluralize } from "@oh-my-pi/pi-utils";
import type { TspPickerAction, TspPickerColumn, TspPickerItem, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { shortenPath } from "../../../utils/render-utils";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { truncateToWidth } from "../../../utils/text-width";
import {
	meshComposeRefusal,
	meshDisplayBlock,
	meshDisplayText,
	meshModeHasSide,
	meshSenderLabel,
} from "./mesh-display";
import type {
	MeshComposeKind,
	MeshManagerApproval,
	MeshManagerEngineStatus,
	MeshManagerMode,
	MeshManagerPeer,
	MeshManagerState,
	MeshManagerThread,
} from "./mesh-manager-types";

/** The order `m` cycles the mode through. */
export const MESH_MODE_ORDER: readonly MeshManagerMode[] = ["local", "remote", "both"];
/** Runtime changes arriving within this window share one state pull. */
export const MESH_CHANGE_COALESCE_MS = 100;
/** How often ages ("seen 12s ago") and approval expiries are redrawn. */
export const MESH_AGE_TICK_MS = 5_000;
/** Cell budget of the one-line summary in a list row. */
const ROW_SUMMARY_CELLS = 120;
/** Rows the selected approval's request text may wrap over. */
const APPROVAL_PREVIEW_ROWS = 6;
/** Cell caps for the self-declared parts of an approval header. */
const APPROVAL_FROM_CELLS = 48;
const APPROVAL_AGENT_CELLS = 24;

/** The mode after `mode` in {@link MESH_MODE_ORDER}. */
export function nextMeshMode(mode: MeshManagerMode): MeshManagerMode {
	return MESH_MODE_ORDER[(MESH_MODE_ORDER.indexOf(mode) + 1) % MESH_MODE_ORDER.length]!;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sanitizing
// ═══════════════════════════════════════════════════════════════════════════

function optionalLine(text: string | undefined): string | undefined {
	const line = meshDisplayText(text);
	return line.length > 0 ? line : undefined;
}

/** A copy of `state` whose every peer-supplied string is safe to render. */
export function sanitizeMeshManagerState(state: MeshManagerState): MeshManagerState {
	return {
		...state,
		self: state.self && {
			instanceId: meshDisplayText(state.self.instanceId),
			displayName: meshDisplayText(state.self.displayName),
			status: { ...state.self.status, error: optionalLine(state.self.status.error) },
		},
		peers: state.peers.map(peer => ({
			...peer,
			endpoint: meshDisplayText(peer.endpoint),
			source: meshDisplayText(peer.source),
			displayName: meshDisplayText(peer.displayName) || meshDisplayText(peer.instanceId),
			host: meshDisplayText(peer.host),
			sessionName: optionalLine(peer.sessionName),
			cwd: meshDisplayText(peer.cwd),
			branch: optionalLine(peer.branch),
			model: optionalLine(peer.model),
			summary: meshDisplayBlock(peer.summary) || undefined,
			agents: peer.agents.map(agent => ({
				id: meshDisplayText(agent.id),
				kind: meshDisplayText(agent.kind),
				displayName: meshDisplayText(agent.displayName),
				status: meshDisplayText(agent.status),
				task: optionalLine(agent.task),
			})),
		})),
		approvals: state.approvals.map(approval => ({
			...approval,
			kind: meshDisplayText(approval.kind),
			fromName: meshDisplayText(approval.fromName),
			fromHost: meshDisplayText(approval.fromHost),
			fromAgent: meshDisplayText(approval.fromAgent),
			fromInstanceId: meshDisplayText(approval.fromInstanceId),
			preview: meshDisplayText(approval.preview),
		})),
	};
}

/** A peer's thread list, safe to render. */
export function sanitizeMeshThreads(list: readonly MeshManagerThread[]): MeshManagerThread[] {
	return list.map(thread => ({
		...thread,
		threadId: meshDisplayText(thread.threadId),
		kind: meshDisplayText(thread.kind),
		status: meshDisplayText(thread.status),
		lastQuestion: optionalLine(thread.lastQuestion),
	}));
}

// ═══════════════════════════════════════════════════════════════════════════
// Sections
// ═══════════════════════════════════════════════════════════════════════════

/** Online before stale, visible before hidden, then by display name and instance id. */
export function compareMeshPeers(a: MeshManagerPeer, b: MeshManagerPeer): number {
	if (a.state !== b.state) return a.state === "online" ? -1 : 1;
	if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
	const byName = a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
	return byName !== 0 ? byName : a.instanceId.localeCompare(b.instanceId);
}

export type MeshManagerItem =
	| { kind: "approval"; key: string; approval: MeshManagerApproval }
	| { kind: "peer"; key: string; peer: MeshManagerPeer };

export interface MeshManagerSection {
	id: "approvals" | "local" | "remote";
	title: string;
	/** False when the current mode does not reach this side. */
	enabled: boolean;
	items: MeshManagerItem[];
	/** Hidden peers left out by the show-hidden toggle. */
	hiddenCount: number;
}

/** The manager's sections: approvals (when any), then local and remote peers. */
export function buildMeshManagerSections(state: MeshManagerState, showHidden: boolean): MeshManagerSection[] {
	const sections: MeshManagerSection[] = [];
	if (state.approvals.length > 0) {
		sections.push({
			id: "approvals",
			title: "Pending approvals",
			enabled: true,
			items: state.approvals.map(approval => ({ kind: "approval", key: `approval:${approval.id}`, approval })),
			hiddenCount: 0,
		});
	}
	for (const side of ["local", "remote"] as const) {
		const all = state.peers.filter(peer => peer.endpointKind === side).sort(compareMeshPeers);
		const shown = showHidden ? all : all.filter(peer => !peer.hidden);
		sections.push({
			id: side,
			title: side === "local" ? "Local" : "Remote",
			enabled: meshModeHasSide(state.mode, side),
			items: shown.map(peer => ({ kind: "peer", key: `peer:${peer.instanceId}`, peer })),
			hiddenCount: all.length - shown.length,
		});
	}
	return sections;
}

/** Selectable items in display order (sections of disabled sides contribute none). */
export function meshManagerItems(sections: readonly MeshManagerSection[]): MeshManagerItem[] {
	return sections.flatMap(section => (section.enabled ? section.items : []));
}

// ═══════════════════════════════════════════════════════════════════════════
// Labels
// ═══════════════════════════════════════════════════════════════════════════

/** `now`, `12s ago`, then {@link formatAge}. */
export function meshAgeLabel(timestamp: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	return seconds < 60 ? (seconds < 5 ? "now" : `${seconds}s ago`) : formatAge(seconds);
}

/** Time left until `expiresAt`: `42s`, `2m5s`. */
export function meshRemainingLabel(expiresAt: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

/** Live feedback while typing a key phrase, counted the way the engine derives the key. */
export function meshKeyPhraseWarning(phrase: string): string | undefined {
	if (phrase.length === 0) return undefined;
	const check = meshPassphraseCheck(phrase);
	if (!check.valid) return `Too short: the mesh requires at least ${check.minChars} characters.`;
	if (check.weak) return `Short phrases are guessable by anyone on your LAN; use ${check.strongChars}+ characters.`;
	return undefined;
}

export const MESH_COMPOSE_KIND_HINT: Readonly<Record<MeshComposeKind, string>> = {
	status: "status: a quick side answer about what the peer is doing (no tools)",
	ask: "ask: a read-only question the peer answers from a forked context",
	steer: "steer: a message into the peer's main agent context",
	note: "note: shown to the peer's human only; nothing answers it",
};

const SIDE_TONE: Readonly<Record<MeshManagerEngineStatus["remote"], string>> = {
	on: "success",
	off: "dim",
	"no-key": "warning",
	error: "error",
};

/** `stale`, `hidden`, `blocked`: the tags a peer carries. */
export function meshPeerTags(peer: MeshManagerPeer): string[] {
	const tags: string[] = [];
	if (peer.state === "stale") tags.push("stale");
	if (peer.hidden) tags.push("hidden");
	if (peer.blocked) tags.push("blocked");
	return tags;
}

/** The claimed sender, capped so it can never crowd the unspoofable instance id and expiry off a row. */
export function meshApprovalSender(approval: MeshManagerApproval): string {
	return truncateToWidth(meshSenderLabel(approval.fromName, approval.fromHost), APPROVAL_FROM_CELLS);
}

/** The one-line head of a peer's summary; only that much of a (possibly 64 KiB) summary is ever measured. */
function rowSummary(peer: MeshManagerPeer): string | undefined {
	return peer.summary
		? truncateToWidth(peer.summary.slice(0, ROW_SUMMARY_CELLS * 2).replaceAll("\n", " "), ROW_SUMMARY_CELLS)
		: undefined;
}

function span(t: string, s?: string): TspSpan {
	return s ? { t, s } : { t };
}

function busySpan(busy: boolean): TspSpan {
	return busy ? span("busy", "warning") : span("idle", "success");
}

/** Spans joined by a dim ` · `. */
function joined(parts: readonly (readonly TspSpan[])[]): TspSpan[] {
	return parts.flatMap((part, index) => (index === 0 ? [...part] : [span(" · ", "dim"), ...part]));
}

/** Mode, side status, LAN port, this instance and engine errors (Tern's subtitle). */
export function meshStatusSpans(state: MeshManagerState): TspSpan[] {
	if (!state.enabled) return [span("disabled", "warning")];
	const parts: TspSpan[][] = [[span("mode ", "muted"), span(state.mode, "accent")]];
	const self = state.self;
	if (self) {
		parts.push([span("local ", "muted"), span(self.status.local, SIDE_TONE[self.status.local])]);
		parts.push([span("remote ", "muted"), span(self.status.remote, SIDE_TONE[self.status.remote])]);
		if (self.status.lanPort !== undefined) parts.push([span("LAN ", "muted"), span(`:${self.status.lanPort}`)]);
		parts.push([span("you ", "muted"), span(self.displayName, "strong")]);
		if (self.status.error) parts.push([span(self.status.error, "error")]);
	} else {
		parts.push([span("engine not running", "warning")]);
	}
	if (meshModeHasSide(state.mode, "remote") && !state.hasKey) parts.push([span("no key phrase", "warning")]);
	return joined(parts);
}

// ═══════════════════════════════════════════════════════════════════════════
// Footer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Packs key hints into at most `maxLines` rows of `width` cells, joined by ` · `; when they do not
 * all fit, the last row ends with `…`. Callers list the hints that must stay visible first.
 */
export function fitMeshHints(hints: readonly string[], width: number, maxLines: number): string[] {
	const sep = " · ";
	const lines: string[] = [];
	let current = "";
	for (const hint of hints) {
		const candidate = current ? `${current}${sep}${hint}` : hint;
		if (visibleWidth(candidate) <= width) {
			current = candidate;
			continue;
		}
		if (current && lines.length + 1 < maxLines) {
			lines.push(current);
			current = hint;
			if (visibleWidth(current) <= width) continue;
		}
		// Out of rows (or one hint wider than a row): mark the rest as cut.
		const room = Math.max(0, width - 1);
		lines.push(`${truncateToWidth(current ? `${current}${sep}` : hint, room, "")}…`);
		return lines;
	}
	if (current) lines.push(current);
	return lines;
}

/** What the footer hints and the action bar depend on. */
export interface MeshActionContext {
	readonly state: MeshManagerState;
	readonly details: boolean;
	readonly prompt: boolean;
	/** The peer an action applies to: the one in details, else the selected row's. */
	readonly target: MeshManagerPeer | undefined;
	readonly selected: MeshManagerItem | undefined;
	readonly showHidden: boolean;
	readonly canAsk: boolean;
}

/** Footer hints of the terminal page, the way out first so a narrow terminal never cuts it. */
export function meshFooterHints(cx: MeshActionContext): string[] {
	if (cx.prompt) return ["esc cancel"];
	if (!cx.state.enabled) return [cx.details ? "esc back" : "esc close", "e enable", "m mode", "k key phrase"];
	const ask = cx.canAsk ? ["q ask"] : [];
	const flags = [cx.target?.hidden ? "h unhide" : "h hide", cx.target?.blocked ? "b unblock" : "b block"];
	const showHidden = cx.showHidden ? "v hide hidden" : "v show hidden";
	const shared = ["c compose", ...ask, ...flags, showHidden, "m mode", "k key", "r refresh", "e disable"];
	if (cx.details) return ["esc back", "↑↓ scroll", ...shared];
	return ["esc close", "↑↓ select", "enter details", "a/d approve/deny", ...shared];
}

function action(id: string, label: string, keys: readonly string[], extra?: Partial<TspPickerAction>): TspPickerAction {
	return { id, label, keys, ...extra };
}

/** The close action: `Close`, or `Back` / `Cancel` where it backs out of a view. */
export function meshCloseAction(label = "Close"): TspPickerAction {
	return action("close", label, ["esc"], { end: true });
}

/** The action bar Tern draws; every id but `details` and `close` is the key it stands for. */
export function meshPickerActions(cx: MeshActionContext): TspPickerAction[] {
	if (!cx.state.enabled) {
		return [
			action("e", "Enable", ["e"], { primary: true }),
			action("m", `Mode: ${cx.state.mode}`, ["m"]),
			action("k", "Key phrase", ["k"]),
			meshCloseAction(),
		];
	}
	const target = cx.target;
	const noPeer = target ? undefined : "Select a peer";
	const lead: TspPickerAction[] = cx.details
		? []
		: cx.selected?.kind === "approval"
			? [action("a", "Approve", ["a"], { primary: true }), action("d", "Deny", ["d"], { danger: true })]
			: [action("details", "Details", ["enter"], { primary: true, disabled: noPeer })];
	const ask = cx.canAsk
		? [action("q", "Ask", ["q"], { disabled: noPeer ?? (target && meshComposeRefusal(target, "ask")) })]
		: [];
	return [
		...lead,
		action("c", "Message", ["c"], { disabled: noPeer }),
		...ask,
		action("h", target?.hidden ? "Unhide" : "Hide", ["h"], { disabled: noPeer, on: target?.hidden }),
		action("b", target?.blocked ? "Unblock" : "Block", ["b"], {
			disabled: noPeer,
			on: target?.blocked,
			danger: true,
		}),
		action("v", "Show hidden", ["v"], { on: cx.showHidden }),
		action("m", `Mode: ${cx.state.mode}`, ["m"]),
		action("k", "Key phrase", ["k"]),
		action("r", "Refresh", ["r"]),
		action("e", "Disable", ["e"]),
		meshCloseAction(cx.details ? "Back" : "Close"),
	];
}

// ═══════════════════════════════════════════════════════════════════════════
// Picker rows (Tern)
// ═══════════════════════════════════════════════════════════════════════════

/** The instance id and expiry, which a renamed peer cannot spoof, outrank everything when the sheet is narrow. */
export const MESH_PICKER_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "state", head: "State", priority: 2 },
	{ id: "seen", head: "Seen", format: "elapsed", priority: 1 },
	{ id: "instance", head: "Instance", format: "dim", priority: 4 },
	{ id: "expires", head: "Expires", priority: 3 },
];

function approvalPickerItem(item: Extract<MeshManagerItem, { kind: "approval" }>, now: number): TspPickerItem {
	const { approval } = item;
	return {
		id: item.key,
		label: [span(approval.kind, "warning strong"), span(" from "), span(meshApprovalSender(approval))],
		detail: truncateToWidth(approval.preview, ROW_SUMMARY_CELLS),
		dot: "warning",
		facts: { instance: approval.fromInstanceId, expires: `in ${meshRemainingLabel(approval.expiresAt, now)}` },
	};
}

function peerPickerItem(item: Extract<MeshManagerItem, { kind: "peer" }>, now: number): TspPickerItem {
	const { peer } = item;
	const detail = [peer.sessionName, rowSummary(peer)].filter(Boolean).join(" — ");
	return {
		id: item.key,
		label: meshSenderLabel(peer.displayName, peer.host),
		...(detail ? { detail } : {}),
		dot: peer.state === "online" ? "success" : "muted",
		badges: meshPeerTags(peer).map(tag => ({ text: tag, tone: (tag === "blocked" ? "error" : "muted") as TspTone })),
		...(peer.hidden || peer.blocked ? { tone: "muted" as const } : {}),
		facts: { state: [busySpan(peer.busy)], seen: Math.max(0, now - peer.lastSeen) },
	};
}

/** The picker's items and group order; a side with nothing to pick keeps its group with a disabled placeholder row. */
export function meshPickerRows(
	sections: readonly MeshManagerSection[],
	mode: MeshManagerMode,
	now: number,
): { items: TspPickerItem[]; order: (string | { group: string; label: string; count?: number })[] } {
	const items: TspPickerItem[] = [];
	const order: (string | { group: string; label: string; count?: number })[] = [];
	for (const section of sections) {
		const hidden = section.hiddenCount > 0 ? ` · ${section.hiddenCount} hidden` : "";
		order.push({
			group: section.id,
			label: `${section.title}${hidden}`,
			...(section.enabled ? { count: section.items.length } : {}),
		});
		if (!section.enabled || section.items.length === 0) {
			// The placeholder's id is no item, so events ignore it.
			const placeholder: TspPickerItem = section.enabled
				? { id: `none:${section.id}`, label: "No peers yet", tone: "muted", disabled: "Nothing discovered yet" }
				: {
						id: `off:${section.id}`,
						label: `Off in mode ${mode}`,
						tone: "muted",
						disabled: "Press m to change the mode",
					};
			items.push(placeholder);
			order.push(placeholder.id);
			continue;
		}
		for (const item of section.items) {
			items.push(item.kind === "approval" ? approvalPickerItem(item, now) : peerPickerItem(item, now));
			order.push(item.key);
		}
	}
	return { items, order };
}

// ═══════════════════════════════════════════════════════════════════════════
// Previews
// ═══════════════════════════════════════════════════════════════════════════

/** A peer's threads as the details view knows them: loading (no list), loaded, or failed. */
export interface MeshThreadsView {
	readonly list?: readonly MeshManagerThread[];
	readonly error?: string;
}

/** A peer's or approval's preview, drawn by Tern's picker preview and the terminal details page. */
export interface MeshDoc {
	readonly title: string;
	/** Tags beside the title (terminal page). */
	readonly tags?: TspSpan;
	/** Label and value; facts without a value are skipped. */
	readonly facts: readonly (readonly [label: string, value: readonly TspSpan[] | undefined])[];
	/** A string body is peer text (wrapped, never markdown); otherwise one span line per row. */
	readonly sections: readonly { id: string; head: string; body: string | readonly (readonly TspSpan[])[] }[];
}

function fact(value: string | undefined, style?: string): TspSpan[] | undefined {
	return value ? [span(value, style)] : undefined;
}

/**
 * A peer's preview. `threads` is set while the details view is open (else the section only points
 * there); `now` marks the terminal page: ages ride inline (Tern clocks "Seen" in a column) and the
 * tags sit beside the title instead of in a fact.
 */
export function meshPeerDoc(peer: MeshManagerPeer, threads: MeshThreadsView | undefined, now?: number): MeshDoc {
	const agents = peer.agents.map(agent => {
		const name = agent.displayName || agent.id;
		// The kind only adds information when the name does not already say it (`main main`).
		const kind = agent.kind && agent.kind.toLowerCase() !== name.toLowerCase() ? ` [${agent.kind}]` : "";
		// Registry lifecycle (alive/finished), not whether the agent is working right now.
		const line: TspSpan[] = [span(name)];
		if (kind) line.push(span(kind, "dim"));
		if (agent.status) line.push(span(` · lifecycle ${agent.status}`, "dim"));
		if (agent.task) line.push(span(` — ${agent.task}`));
		return line;
	});
	let threadLines: TspSpan[][];
	if (!threads) threadLines = [[span("Open Details to list the threads this peer opened here.", "dim")]];
	else if (!threads.list) threadLines = [[span("loading…", "dim")]];
	else if (threads.error) threadLines = [[span(threads.error, "error")]];
	else if (threads.list.length === 0) threadLines = [[span("none", "dim")]];
	else {
		threadLines = threads.list.map(thread => {
			const age = now === undefined ? "" : ` · ${meshAgeLabel(thread.updatedAt, now)}`;
			const meta = `${thread.kind} · ${thread.turns} ${pluralize("turn", thread.turns)} · ${thread.status}${age}`;
			const line = [span(thread.threadId, "mono"), span(` ${meta}`, "dim")];
			if (thread.lastQuestion) line.push(span(` — ${thread.lastQuestion}`));
			return line;
		});
	}
	const tags = meshPeerTags(peer);
	const seen = now === undefined ? "" : ` · seen ${meshAgeLabel(peer.lastSeen, now)}`;
	return {
		title: meshSenderLabel(peer.displayName, peer.host),
		...(now !== undefined && tags.length > 0
			? { tags: span(` [${tags.join(", ")}]`, peer.blocked ? "error" : "dim") }
			: {}),
		facts: [
			["Instance", fact(meshDisplayText(peer.instanceId))],
			["Endpoint", [span(`${peer.endpoint} `), span(`(${peer.source})`, "dim")]],
			["State", [busySpan(peer.busy), span(` · ${peer.state}${seen}`)]],
			["Tags", now === undefined ? fact(tags.join(", ")) : undefined],
			["Session", fact(peer.sessionName)],
			["Cwd", fact(peer.cwd ? shortenPath(peer.cwd) : undefined)],
			["Branch", fact(peer.branch)],
			["Model", fact(peer.model)],
		],
		sections: [
			{ id: "summary", head: "Summary", body: peer.summary ?? [[span("none yet", "dim")]] },
			{
				id: "agents",
				head: `Agents (${peer.agents.length})`,
				body: agents.length > 0 ? agents : [[span("none reported", "dim")]],
			},
			{
				id: "threads",
				head: threads?.list ? `Threads from this peer (${threads.list.length})` : "Threads from this peer",
				body: threadLines,
			},
		],
	};
}

/** An approval's preview: the unspoofable instance id first, the self-declared sender and agent capped. */
export function meshApprovalDoc(approval: MeshManagerApproval, now: number): MeshDoc {
	return {
		title: `${approval.kind} request`,
		facts: [
			["Instance", fact(approval.fromInstanceId)],
			["From", fact(meshApprovalSender(approval))],
			["Agent", fact(truncateToWidth(approval.fromAgent, APPROVAL_AGENT_CELLS))],
			["Expires", fact(`in ${meshRemainingLabel(approval.expiresAt, now)}`)],
		],
		sections: [{ id: "request", head: "Request", body: approval.preview }],
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Terminal page rows
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One logical row of the terminal page. The look cuts it to the width, or with `wrap` wraps it
 * over at most that many rows (the last cut with `…`) indented by `indent` cells. `item` makes the
 * row a click target for that item; `field` draws a text field (its caret) instead of `spans`.
 */
export type MeshRow = {
	readonly spans: readonly TspSpan[];
	readonly indent?: number;
	readonly wrap?: number;
	readonly item?: string;
	readonly field?: { readonly text: string; readonly cursor: number };
};

/** The page header: mode, side status, LAN port and key warning, then this instance and engine errors. */
export function meshHeaderRows(state: MeshManagerState): MeshRow[] {
	if (!state.enabled) {
		return [
			{
				spans: [span("Mesh is disabled.", "warning"), span(" Press e to enable it (mesh.enabled).", "muted")],
			},
		];
	}
	const parts: TspSpan[][] = [[span("mode", "muted"), span(" "), span(state.mode, "accent")]];
	const self = state.self;
	if (self) {
		parts.push([span("local ", "muted"), span(self.status.local, SIDE_TONE[self.status.local])]);
		parts.push([span("remote ", "muted"), span(self.status.remote, SIDE_TONE[self.status.remote])]);
		if (self.status.lanPort !== undefined) parts.push([span("LAN", "muted"), span(` :${self.status.lanPort}`)]);
	} else {
		parts.push([span("engine not running", "warning")]);
	}
	if (meshModeHasSide(state.mode, "remote") && !state.hasKey) parts.push([span("no key (press k)", "warning")]);
	const rows: MeshRow[] = [{ spans: joined(parts) }];
	if (self) {
		rows.push({
			spans: joined([[span("you ", "muted"), span(self.displayName, "strong")], [span(self.instanceId, "dim")]]),
		});
		if (self.status.error) rows.push({ spans: [span(self.status.error, "error")] });
	}
	return rows;
}

/** Two rows per (sanitized) peer: identity and run state, then where it works and what it does. */
function peerRows(peer: MeshManagerPeer, key: string, selected: boolean, now: number): MeshRow[] {
	// Hidden and blocked peers draw dim unless selected.
	const dim = (peer.hidden || peer.blocked) && !selected;
	const style = (s: string | undefined) => (dim ? "dim" : s);
	const tags = meshPeerTags(peer);
	const name: TspSpan[] = [
		span(peer.state === "online" ? "●" : "○", style(peer.state === "online" ? "success" : "dim")),
		span(" "),
		span(peer.displayName, style(selected ? "strong" : undefined)),
	];
	if (tags.length > 0) name.push(span(` [${tags.join(", ")}]`, style(peer.blocked ? "error" : "dim")));
	const parts: TspSpan[][] = [name];
	if (peer.sessionName) parts.push([span(peer.sessionName, style("text"))]);
	parts.push([span(peer.endpoint, style("muted"))]);
	const busy = busySpan(peer.busy);
	parts.push([span(busy.t, style(busy.s))]);
	parts.push([span(meshAgeLabel(peer.lastSeen, now), "dim")]);
	const facts = [
		peer.cwd ? shortenPath(peer.cwd) : undefined,
		peer.branch ? `⎇ ${peer.branch}` : undefined,
		peer.model,
	]
		.filter(part => part !== undefined)
		.join(" · ");
	const tail = [facts, rowSummary(peer)].filter(Boolean).join(" — ");
	const prefix = selected ? span("› ", "accent") : span("  ");
	return [
		{ spans: [prefix, ...joined(parts)], item: key },
		{ spans: [span("    "), span(tail, "dim")], item: key },
	];
}

/**
 * A (sanitized) approval: the instance id (which renaming cannot spoof) and expiry lead the header,
 * so the self-declared name, host and agent (capped) can never push them off screen; the selected
 * row wraps the request preview (already bounded by the approval queue) over a few rows.
 */
function approvalRows(approval: MeshManagerApproval, key: string, selected: boolean, now: number): MeshRow[] {
	const from = meshApprovalSender(approval);
	const agent = truncateToWidth(approval.fromAgent, APPROVAL_AGENT_CELLS);
	const meta = `${approval.fromInstanceId} · expires in ${meshRemainingLabel(approval.expiresAt, now)}`;
	const rows: MeshRow[] = [
		{
			spans: [
				selected ? span("› ", "accent") : span("  "),
				span(approval.kind, "warning"),
				span(" "),
				span(meta, "dim"),
				span(" · from "),
				span(from, selected ? "strong" : undefined),
				span(" "),
				span(`(${agent})`, "dim"),
			],
			item: key,
		},
	];
	if (!selected) {
		rows.push({ spans: [span("    "), span(approval.preview, "dim")], item: key });
		return rows;
	}
	rows.push({ spans: [span(approval.preview)], indent: 4, wrap: APPROVAL_PREVIEW_ROWS, item: key });
	rows.push({ spans: [span("    "), span("a approve · d deny", "dim")], item: key });
	return rows;
}

/** The list page: section heads and item rows; `selected` marks the rows to keep on screen. */
export function meshListRows(
	sections: readonly MeshManagerSection[],
	selectedKey: string | undefined,
	now: number,
): { rows: MeshRow[]; selected: { start: number; end: number } } {
	const rows: MeshRow[] = [];
	const selected = { start: 0, end: 0 };
	for (const section of sections) {
		if (rows.length > 0) rows.push({ spans: [] });
		const head: TspSpan[] = [span(section.title, "strong accent")];
		if (section.enabled) head.push(span(` (${section.items.length})`));
		if (section.hiddenCount > 0) head.push(span(` · ${section.hiddenCount} hidden (v)`, "dim"));
		rows.push({ spans: head });
		if (!section.enabled) {
			rows.push({ spans: [span("  disabled in this mode (m to change)", "dim")] });
			continue;
		}
		if (section.items.length === 0) {
			rows.push({ spans: [span("  none", "dim")] });
			continue;
		}
		for (const item of section.items) {
			const isSelected = item.key === selectedKey;
			if (isSelected) selected.start = rows.length;
			rows.push(
				...(item.kind === "approval"
					? approvalRows(item.approval, item.key, isSelected, now)
					: peerRows(item.peer, item.key, isSelected, now)),
			);
			if (isSelected) selected.end = rows.length;
		}
	}
	return { rows, selected };
}

/** The list page while the mesh is off: what it is for. */
export const MESH_DISABLED_ROWS: readonly MeshRow[] = [
	{ spans: [] },
	{ spans: [span("The mesh lets this omp instance discover other instances on this PC (local)", "muted")] },
	{ spans: [span("or your LAN (remote, with a shared key phrase) and message their agents.", "muted")] },
];

/** A preview as page rows: title and tags, facts in a label column, then each section. */
export function meshDocRows(doc: MeshDoc): MeshRow[] {
	const rows: MeshRow[] = [{ spans: [span(doc.title, "strong"), ...(doc.tags ? [doc.tags] : [])] }];
	for (const [label, value] of doc.facts) {
		if (value) rows.push({ spans: [span(label.toLowerCase().padEnd(10), "muted"), ...value] });
	}
	for (const section of doc.sections) {
		rows.push({ spans: [] }, { spans: [span(section.head, "strong")] });
		if (typeof section.body === "string") {
			for (const paragraph of section.body.split("\n")) {
				rows.push({ spans: [span(paragraph)], indent: 2, wrap: Number.POSITIVE_INFINITY });
			}
			continue;
		}
		for (const line of section.body) rows.push({ spans: [span("  "), ...line] });
	}
	return rows;
}
