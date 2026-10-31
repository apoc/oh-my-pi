/**
 * `/mesh` manager: a fullscreen overlay listing pending inbound approvals and the local and
 * remote mesh peers, with a details view per peer and the actions the human owns (mode, key
 * phrase, hide/block, approvals, compose). Live: the host's runtime pushes changes, renders
 * coalesce, and an age tick keeps "last seen" and approval expiry current.
 *
 * Peer data is untrusted: {@link sanitizeMeshManagerState} strips ANSI, C0/C1 and bidi controls,
 * newlines (except in summaries) and tabs from every string once per state pull, before anything is
 * styled, measured or sorted. Thread lists and notices are sanitized when they arrive.
 */
import { formatAge, pluralize, stripBidiControls } from "@oh-my-pi/pi-utils";
import type { TspPickerAction, TspPickerColumn, TspPickerGroup, TspPickerItem, TspSpan } from "@oh-my-pi/pi-wire";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { Input } from "../components/input";
import { getKeybindings } from "../keybindings";
import { matchesKey } from "../keys";
import { parseSgrMouse } from "../mouse";
import { col, compact, keyed, kv, node, span, text } from "../native/describe";
import { Memo } from "../native/memo";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { CLOSE_ACTION, picker, pickerAction, pickerEvent } from "../native/picker";
import { shortenPath } from "../render/render-utils";
import { theme } from "../theme";
import type { ThemeColor } from "../theme/schema";
import type { Component } from "../tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./extensions/display-text";
import {
	MESH_COMPOSE_KINDS,
	type MeshComposeKind,
	type MeshManagerApproval,
	type MeshManagerEngineStatus,
	type MeshManagerMode,
	type MeshManagerPeer,
	type MeshManagerRuntime,
	type MeshManagerState,
	type MeshManagerThread,
} from "./mesh-manager-types";

/** Key phrases shorter than this are guessable; the manager warns below it. */
export const MESH_MIN_KEY_PHRASE_CHARS = 16;
/** The engine rejects shorter key phrases (`meshDeriveKey`); mirrored here only to warn while typing. */
export const MESH_REQUIRED_KEY_PHRASE_CHARS = 12;
const MODE_ORDER: readonly MeshManagerMode[] = ["local", "remote", "both"];
const CHANGE_COALESCE_MS = 100;
const AGE_TICK_MS = 5_000;
/** Cell budget of the one-line summary in a list row. */
const ROW_SUMMARY_CELLS = 120;
/** Rows the selected approval's request text may wrap over. */
const APPROVAL_PREVIEW_ROWS = 6;
/** Cell caps for the self-declared parts of an approval header. */
const APPROVAL_FROM_CELLS = 48;
const APPROVAL_AGENT_CELLS = 24;

// ═══════════════════════════════════════════════════════════════════════════
// Pure row model
// ═══════════════════════════════════════════════════════════════════════════

/** A peer-supplied string as one safe display line; empty when missing. Bidi controls go first so no whitespace they framed survives. */
export function meshDisplayText(text: string | null | undefined): string {
	return typeof text === "string" && text.length > 0 ? sanitizeDisplayLine(stripBidiControls(text)) : "";
}

/** A peer-supplied multi-line text (summary, note, reply), safe to render; empty when missing. */
export function meshDisplayBlock(text: string | null | undefined): string {
	return typeof text === "string" && text.length > 0 ? sanitizeDisplayText(stripBidiControls(text)).trim() : "";
}

/**
 * Packs key hints into at most `maxLines` rows of `width` cells, joined by ` · `; when they do not
 * all fit, the last row ends with `…`. Callers list the hints that must stay visible first.
 */
export function fitMeshHints(hints: readonly string[], width: number, maxLines: number): string[] {
	const sep = " · ";
	const lines: string[] = [];
	let current = "";
	for (let index = 0; index < hints.length; index++) {
		const hint = hints[index]!;
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

/** Whether `mode` reaches peers of the `local` / `remote` side. */
export function meshModeHasSide(mode: MeshManagerMode, side: "local" | "remote"): boolean {
	return mode === "both" || mode === side;
}

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

/** Counts for the status line: visible, unblocked, online peers per side. */
export function countMeshPeers(peers: readonly MeshManagerPeer[]): { local: number; remote: number } {
	let local = 0;
	let remote = 0;
	for (const peer of peers) {
		if (peer.hidden || peer.blocked || peer.state !== "online") continue;
		if (peer.endpointKind === "local") local++;
		else remote++;
	}
	return { local, remote };
}

/** Why `kind` cannot be sent to `peer`, or undefined when it can: a blocked peer's answers never arrive. */
export function meshComposeRefusal(peer: MeshManagerPeer, kind: MeshComposeKind): string | undefined {
	if (!peer.blocked || kind === "note") return undefined;
	return `${peer.displayName} is blocked, so its answer could never arrive. Unblock it (b) or send a note.`;
}

/** `name@host`, or `name` alone when it already ends with `@host` (default display names are `user@host`). */
export function meshSenderLabel(name: string, host: string): string {
	return host && !name.endsWith(`@${host}`) ? `${name}@${host}` : name;
}

function ageLabel(timestamp: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	return seconds < 60 ? (seconds < 5 ? "now" : `${seconds}s ago`) : formatAge(seconds);
}

function remainingLabel(expiresAt: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ═══════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════

export interface MeshManagerOptions {
	requestRender(): void;
	/** Terminal rows the fullscreen overlay fills. */
	rows(): number;
	onClose(): void;
	/** Ask `instanceId` a side question; set to offer the `q` / "Ask" action. The manager closes first. */
	onAsk?(instanceId: string): void;
}

type KeyPrompt = { kind: "key"; step: "enter" | "confirm"; first: string; input: Input; busy: boolean };
type ComposeTextPrompt = {
	kind: "compose-text";
	peerId: string;
	composeKind: MeshComposeKind;
	input: Input;
	busy: boolean;
};
type Prompt = KeyPrompt | { kind: "compose-kind"; peerId: string; index: number } | ComposeTextPrompt;

type NoticeTone = "success" | "warning" | "error" | "muted";

interface Notice {
	tone: NoticeTone;
	text: string;
}

export class MeshManagerComponent implements Component {
	readonly #runtime: MeshManagerRuntime;
	readonly #options: MeshManagerOptions;
	readonly #unsubscribe: () => void;
	readonly #tick: NodeJS.Timeout;
	#changeTimer: NodeJS.Timeout | undefined;
	#state: MeshManagerState;
	#selectedKey: string | undefined;
	#showHidden = false;
	#details: { peerId: string; scroll: number } | undefined;
	#threads: { peerId: string; list: readonly MeshManagerThread[] | undefined; error?: string } | undefined;
	#threadsGeneration = 0;
	#prompt: Prompt | undefined;
	#notice: Notice | undefined;
	#listScroll = 0;
	#disposed = false;
	/** Whether the terminal draws `picker` sheets; set by {@link nativeSheet}, read by {@link nativeOverlay}. */
	#nativePicker = false;
	readonly #viewMemo = new Memo<{ sections: MeshManagerSection[]; items: MeshManagerItem[] }>();
	readonly #rowsMemo = new Memo<PickerRows>();
	readonly #pickerMemo = new Memo();
	readonly #promptMemo = new Memo();

	constructor(runtime: MeshManagerRuntime, options: MeshManagerOptions) {
		this.#runtime = runtime;
		this.#options = options;
		this.#state = sanitizeMeshManagerState(runtime.getState());
		this.#selectedKey = this.#selected()?.key;
		this.#unsubscribe = runtime.subscribe(() => this.#scheduleChange());
		this.#tick = setInterval(() => this.#options.requestRender(), AGE_TICK_MS);
		this.#tick.unref?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		clearInterval(this.#tick);
		clearTimeout(this.#changeTimer);
		this.#changeTimer = undefined;
	}

	invalidate(): void {}

	// -- data ------------------------------------------------------------------

	#scheduleChange(): void {
		if (this.#disposed || this.#changeTimer) return;
		this.#changeTimer = setTimeout(() => {
			this.#changeTimer = undefined;
			this.#pull();
		}, CHANGE_COALESCE_MS);
		this.#changeTimer.unref?.();
	}

	#pull(): void {
		if (this.#disposed) return;
		this.#state = sanitizeMeshManagerState(this.#runtime.getState());
		if (this.#details) this.#loadThreads(this.#details.peerId);
		this.#options.requestRender();
	}

	#loadThreads(peerId: string): void {
		const generation = ++this.#threadsGeneration;
		if (this.#threads?.peerId !== peerId) this.#threads = { peerId, list: undefined };
		this.#runtime.listThreads(peerId).then(
			list => {
				if (this.#disposed || generation !== this.#threadsGeneration) return;
				const safe = list.map(thread => ({
					...thread,
					threadId: meshDisplayText(thread.threadId),
					kind: meshDisplayText(thread.kind),
					status: meshDisplayText(thread.status),
					lastQuestion: optionalLine(thread.lastQuestion),
				}));
				this.#threads = { peerId, list: safe };
				this.#options.requestRender();
			},
			(error: unknown) => {
				if (this.#disposed || generation !== this.#threadsGeneration) return;
				this.#threads = { peerId, list: [], error: meshDisplayText(errorText(error)) };
				this.#options.requestRender();
			},
		);
	}

	/** Notices can carry peer or engine text; sanitized once here. */
	#notify(tone: NoticeTone, text: string): void {
		this.#notice = { tone, text: meshDisplayText(text) };
	}

	/** Sections and their selectable items, rebuilt only when the state or the hidden toggle changes. */
	#view(): { sections: MeshManagerSection[]; items: MeshManagerItem[] } {
		return this.#viewMemo.get([this.#state, this.#showHidden], () => {
			const sections = buildMeshManagerSections(this.#state, this.#showHidden);
			return { sections, items: meshManagerItems(sections) };
		});
	}

	#items(): MeshManagerItem[] {
		return this.#view().items;
	}

	#selected(items = this.#items()): MeshManagerItem | undefined {
		return items.find(item => item.key === this.#selectedKey) ?? items[0];
	}

	#selectedPeer(): MeshManagerPeer | undefined {
		const item = this.#selected();
		return item?.kind === "peer" ? item.peer : undefined;
	}

	#peer(instanceId: string): MeshManagerPeer | undefined {
		return this.#state.peers.find(peer => peer.instanceId === instanceId);
	}

	/** A peer's sanitized display name, or its sanitized id once it is gone. */
	#peerName(instanceId: string): string {
		return this.#peer(instanceId)?.displayName ?? meshDisplayText(instanceId);
	}

	// -- input -----------------------------------------------------------------

	handleInput(data: string): void {
		// The fullscreen overlay enables mouse tracking; reports are not keys.
		if (data.startsWith("\x1b[<") && parseSgrMouse(data)) return;
		if (matchesKey(data, "ctrl+c")) {
			this.#close();
			return;
		}
		if (this.#prompt) {
			this.#handlePromptInput(this.#prompt, data);
			return;
		}
		if (this.#details) {
			this.#handleDetailsInput(this.#details, data);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.#close();
			return;
		}
		if (matchesKey(data, "up")) this.#move(-1);
		else if (matchesKey(data, "down")) this.#move(1);
		else if (matchesKey(data, "enter")) this.#openDetails();
		else if (!this.#handleAction(data)) return;
		this.#options.requestRender();
	}

	/** Actions shared by the list and the details view; false when `data` is none. */
	#handleAction(data: string): boolean {
		if (data === "e") this.#toggleEnabled();
		else if (data === "m") this.#cycleMode();
		else if (data === "k") this.#openKeyPrompt();
		else if (data === "r") this.#refresh();
		else if (!this.#state.enabled) return false;
		else if (data === "v") {
			this.#showHidden = !this.#showHidden;
			this.#notify("muted", this.#showHidden ? "Showing hidden peers" : "Hiding hidden peers");
		} else if (data === "a" || data === "d") this.#decide(data === "a");
		else if (data === "h") this.#toggleFlag("hidden");
		else if (data === "b") this.#toggleFlag("blocked");
		else if (data === "c") this.#openCompose();
		else if (data === "q" && this.#options.onAsk) this.#ask(this.#options.onAsk);
		else return false;
		return true;
	}

	#handleDetailsInput(details: { peerId: string; scroll: number }, data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter")) this.#details = undefined;
		else if (matchesKey(data, "up")) details.scroll = Math.max(0, details.scroll - 1);
		else if (matchesKey(data, "down")) details.scroll++;
		else if (!this.#handleAction(data)) return;
		this.#options.requestRender();
	}

	#handlePromptInput(prompt: Prompt, data: string): void {
		if (prompt.kind === "compose-kind") {
			if (matchesKey(data, "escape")) this.#prompt = undefined;
			else if (matchesKey(data, "left")) prompt.index = Math.max(0, prompt.index - 1);
			else if (matchesKey(data, "right")) prompt.index = Math.min(MESH_COMPOSE_KINDS.length - 1, prompt.index + 1);
			else if (matchesKey(data, "enter")) this.#openComposeText(prompt.peerId, MESH_COMPOSE_KINDS[prompt.index]!);
			else {
				const digit = Number.parseInt(data, 10);
				if (!(digit >= 1 && digit <= MESH_COMPOSE_KINDS.length) || data.length !== 1) return;
				this.#openComposeText(prompt.peerId, MESH_COMPOSE_KINDS[digit - 1]!);
			}
			this.#options.requestRender();
			return;
		}
		if (prompt.busy) return;
		prompt.input.handleInput(data);
		this.#options.requestRender();
	}

	#move(delta: number): void {
		const items = this.#items();
		if (items.length === 0) return;
		const current = this.#selected(items);
		const index = current ? items.indexOf(current) : 0;
		const next = items[Math.max(0, Math.min(items.length - 1, index + delta))];
		this.#selectedKey = next?.key;
	}

	#openDetails(): void {
		const peer = this.#selectedPeer();
		if (!peer) return;
		this.#details = { peerId: peer.instanceId, scroll: 0 };
		this.#loadThreads(peer.instanceId);
	}

	#close(): void {
		this.dispose();
		this.#options.onClose();
	}

	#attempt(action: () => void): void {
		try {
			action();
		} catch (error) {
			this.#notify("error", errorText(error));
		}
	}

	#toggleEnabled(): void {
		const enabled = !this.#state.enabled;
		this.#attempt(() => {
			this.#runtime.setEnabled(enabled);
			this.#notify("success", enabled ? "Mesh enabled" : "Mesh disabled");
			this.#pull();
		});
	}

	#cycleMode(): void {
		const mode = MODE_ORDER[(MODE_ORDER.indexOf(this.#state.mode) + 1) % MODE_ORDER.length]!;
		this.#attempt(() => {
			this.#runtime.setMode(mode);
			const keyHint = mode !== "local" && !this.#state.hasKey ? " (remote needs a key phrase: press k)" : "";
			this.#notify("success", `Mesh mode: ${mode}${keyHint}`);
			this.#pull();
		});
	}

	#refresh(): void {
		this.#notify("muted", "Refreshing peers…");
		this.#attempt(() => this.#runtime.refresh());
		this.#pull();
	}

	#decide(allow: boolean): void {
		// Exactly the row the user sees selected, never the first-row fallback: a new approval sorted
		// ahead of it must not be the one a click or key resolves.
		const item = this.#items().find(candidate => candidate.key === this.#selectedKey);
		if (item?.kind !== "approval") {
			this.#notify("muted", "Select a pending approval first");
			return;
		}
		this.#attempt(() => {
			this.#runtime.resolveApproval(item.approval.id, allow);
			this.#notify(
				allow ? "success" : "warning",
				`${allow ? "Approved" : "Denied"} ${item.approval.kind} from ${item.approval.fromName}`,
			);
			this.#pull();
		});
	}

	/** The peer an action applies to: the one in details, else the selected row's. */
	#targetPeer(): MeshManagerPeer | undefined {
		return this.#details ? this.#peer(this.#details.peerId) : this.#selectedPeer();
	}

	#toggleFlag(flag: "hidden" | "blocked"): void {
		const peer = this.#targetPeer();
		if (!peer) return;
		const value = !peer[flag];
		this.#attempt(() => {
			this.#runtime.setPeerFlags(peer.instanceId, { [flag]: value });
			const verb = flag === "hidden" ? (value ? "Hid" : "Unhid") : value ? "Blocked" : "Unblocked";
			this.#notify("muted", `${verb} ${peer.displayName}`);
			this.#pull();
		});
	}

	#newInput(mask: boolean, onSubmit: (value: string) => void): Input {
		const input = new Input();
		input.prompt = "";
		input.mask = mask;
		input.focused = true;
		input.onSubmit = onSubmit;
		input.onEscape = () => {
			this.#prompt = undefined;
			this.#options.requestRender();
		};
		return input;
	}

	#openKeyPrompt(step: KeyPrompt["step"] = "enter", first = ""): void {
		const prompt: KeyPrompt = {
			kind: "key",
			step,
			first,
			busy: false,
			input: this.#newInput(true, value => void this.#submitKey(prompt, value)),
		};
		this.#prompt = prompt;
	}

	async #submitKey(prompt: KeyPrompt, phrase: string): Promise<void> {
		if (prompt.step === "enter") {
			if (phrase.trim().length === 0) {
				this.#notify("error", "The key phrase cannot be blank");
			} else {
				this.#notice = undefined;
				this.#openKeyPrompt("confirm", phrase);
			}
			this.#options.requestRender();
			return;
		}
		if (phrase !== prompt.first) {
			this.#notify("error", "The phrases do not match; enter it again");
			this.#openKeyPrompt();
			this.#options.requestRender();
			return;
		}
		prompt.busy = true;
		this.#notify("muted", "Deriving the mesh key…");
		this.#options.requestRender();
		try {
			await this.#runtime.setKeyPhrase(phrase);
			if (this.#disposed) return;
			this.#notify("success", "Mesh key set; use the same phrase on your other machines");
			this.#prompt = undefined;
			this.#pull();
		} catch (error) {
			if (this.#disposed) return;
			this.#notify("error", `Key not set: ${errorText(error)}`);
			this.#openKeyPrompt();
			this.#options.requestRender();
		}
	}

	#openCompose(): void {
		const peer = this.#targetPeer();
		if (!peer) {
			this.#notify("muted", "Select a peer to message");
			return;
		}
		this.#prompt = {
			kind: "compose-kind",
			peerId: peer.instanceId,
			index: peer.blocked ? MESH_COMPOSE_KINDS.indexOf("note") : 0,
		};
	}

	/** Hand the target peer to the host's side-question flow, closing first so the host takes focus back. */
	#ask(onAsk: (instanceId: string) => void): void {
		const peer = this.#targetPeer();
		if (!peer) {
			this.#notify("muted", "Select a peer to ask");
			return;
		}
		const refusal = meshComposeRefusal(peer, "ask");
		if (refusal) {
			this.#notify("error", refusal);
			return;
		}
		this.#close();
		onAsk(peer.instanceId);
	}

	#openComposeText(peerId: string, composeKind: MeshComposeKind): void {
		const peer = this.#peer(peerId);
		const refusal = peer && meshComposeRefusal(peer, composeKind);
		if (refusal) {
			this.#notify("error", refusal);
			return;
		}
		const prompt: ComposeTextPrompt = {
			kind: "compose-text",
			peerId,
			composeKind,
			busy: false,
			input: this.#newInput(false, value => void this.#submitCompose(prompt, value)),
		};
		this.#prompt = prompt;
	}

	async #submitCompose(prompt: ComposeTextPrompt, text: string): Promise<void> {
		if (text.trim().length === 0) return;
		const name = this.#peerName(prompt.peerId);
		prompt.busy = true;
		this.#notify("muted", `Sending ${prompt.composeKind} to ${name}…`);
		this.#options.requestRender();
		let notice: Notice;
		try {
			const outcome = await this.#runtime.send(prompt.peerId, prompt.composeKind, text);
			if (outcome.ok) {
				const thread = outcome.thread ? ` (thread ${outcome.thread})` : "";
				const answer = prompt.composeKind === "note" ? "" : "; the reply will appear in the transcript";
				notice = { tone: "success", text: `Sent ${prompt.composeKind} to ${name}${thread}${answer}` };
			} else {
				notice = { tone: "error", text: `Not sent: ${outcome.message}` };
			}
		} catch (error) {
			notice = { tone: "error", text: `Not sent: ${errorText(error)}` };
		}
		if (this.#disposed) return;
		this.#notify(notice.tone, notice.text);
		if (notice.tone === "success") this.#prompt = undefined;
		else prompt.busy = false;
		this.#options.requestRender();
	}

	// -- render ----------------------------------------------------------------

	render(width: number): readonly string[] {
		const height = Math.max(8, this.#options.rows());
		const inner = Math.max(1, width - 4);
		const now = Date.now();
		const header = this.#renderHeader(inner);
		const bottom = this.#renderBottom(inner);
		// Borders: top, two dividers, bottom.
		const bodyHeight = Math.max(1, height - header.length - bottom.length - 4);
		const body = this.#details
			? this.#renderDetails(inner, bodyHeight, now)
			: this.#renderList(inner, bodyHeight, now);
		const lines = [topBorder(width, "Mesh")];
		for (const line of header) lines.push(row(line, width));
		lines.push(divider(width));
		for (const line of body) lines.push(row(line, width));
		for (let i = body.length; i < bodyHeight; i++) lines.push(row("", width));
		lines.push(divider(width));
		for (const line of bottom) lines.push(row(line, width));
		lines.push(bottomBorder(width));
		return lines;
	}

	#renderHeader(inner: number): string[] {
		const state = this.#state;
		const sep = theme.fg("dim", " · ");
		if (!state.enabled) {
			return [
				truncateToWidth(
					`${theme.fg("warning", "Mesh is disabled.")} ${theme.fg("muted", "Press e to enable it (mesh.enabled).")}`,
					inner,
				),
			];
		}
		const parts = [`${theme.fg("muted", "mode")} ${theme.fg("accent", state.mode)}`];
		const self = state.self;
		if (self) {
			parts.push(`${theme.fg("muted", "local")} ${theme.fg(SIDE_TONE[self.status.local], self.status.local)}`);
			parts.push(`${theme.fg("muted", "remote")} ${theme.fg(SIDE_TONE[self.status.remote], self.status.remote)}`);
			if (self.status.lanPort !== undefined) parts.push(`${theme.fg("muted", "LAN")} :${self.status.lanPort}`);
		} else {
			parts.push(theme.fg("warning", "engine not running"));
		}
		if (meshModeHasSide(state.mode, "remote") && !state.hasKey) parts.push(theme.fg("warning", "no key (press k)"));
		const lines = [truncateToWidth(parts.join(sep), inner)];
		if (self) {
			lines.push(
				truncateToWidth(
					`${theme.fg("muted", "you")} ${theme.bold(self.displayName)}${sep}${theme.fg("dim", self.instanceId)}`,
					inner,
				),
			);
			if (self.status.error) lines.push(truncateToWidth(theme.fg("error", self.status.error), inner));
		}
		return lines;
	}

	#renderList(inner: number, height: number, now: number): string[] {
		if (!this.#state.enabled) {
			return [
				"",
				theme.fg("muted", "The mesh lets this omp instance discover other instances on this PC (local)"),
				theme.fg("muted", "or your LAN (remote, with a shared key phrase) and message their agents."),
			].map(line => truncateToWidth(line, inner));
		}
		const { sections, items } = this.#view();
		const selected = this.#selected(items);
		this.#selectedKey = selected?.key;
		const lines: string[] = [];
		let selStart = 0;
		let selEnd = 0;
		for (const section of sections) {
			if (lines.length > 0) lines.push("");
			const count = section.enabled ? ` (${section.items.length})` : "";
			const hidden = section.hiddenCount > 0 ? theme.fg("dim", ` · ${section.hiddenCount} hidden (v)`) : "";
			lines.push(truncateToWidth(`${theme.bold(theme.fg("accent", section.title))}${count}${hidden}`, inner));
			if (!section.enabled) {
				lines.push(truncateToWidth(theme.fg("dim", "  disabled in this mode (m to change)"), inner));
				continue;
			}
			if (section.items.length === 0) {
				lines.push(theme.fg("dim", "  none"));
				continue;
			}
			for (const item of section.items) {
				const isSelected = item === selected;
				if (isSelected) selStart = lines.length;
				const rows =
					item.kind === "approval"
						? approvalRows(item.approval, isSelected, inner, now)
						: peerRows(item.peer, isSelected, inner, now);
				lines.push(...rows);
				if (isSelected) selEnd = lines.length;
			}
		}
		// Keep the selected item's rows on screen.
		if (selEnd - this.#listScroll > height) this.#listScroll = selEnd - height;
		if (selStart < this.#listScroll) this.#listScroll = selStart;
		this.#listScroll = Math.max(0, Math.min(this.#listScroll, Math.max(0, lines.length - height)));
		return lines.slice(this.#listScroll, this.#listScroll + height);
	}

	#renderDetails(inner: number, height: number, now: number): string[] {
		const details = this.#details!;
		const peer = this.#peer(details.peerId);
		if (!peer) return [theme.fg("warning", "This peer is gone."), theme.fg("dim", "Esc to go back")];
		const label = (name: string) => theme.fg("muted", name.padEnd(10));
		const lines: string[] = [];
		lines.push(`${theme.bold(meshSenderLabel(peer.displayName, peer.host))}${peerTags(peer)}`);
		lines.push(`${label("instance")}${meshDisplayText(peer.instanceId)}`);
		lines.push(`${label("endpoint")}${peer.endpoint} ${theme.fg("dim", `(${peer.source})`)}`);
		lines.push(`${label("state")}${busyLabel(peer.busy)} · ${peer.state} · seen ${ageLabel(peer.lastSeen, now)}`);
		if (peer.sessionName) lines.push(`${label("session")}${peer.sessionName}`);
		if (peer.cwd) lines.push(`${label("cwd")}${shortenPath(peer.cwd)}`);
		if (peer.branch) lines.push(`${label("branch")}${peer.branch}`);
		if (peer.model) lines.push(`${label("model")}${peer.model}`);
		lines.push("");
		lines.push(theme.bold("Summary"));
		if (peer.summary) {
			for (const paragraph of peer.summary.split("\n")) {
				for (const wrapped of wrapTextWithAnsi(paragraph, Math.max(1, inner - 2))) lines.push(`  ${wrapped}`);
			}
		} else {
			lines.push(theme.fg("dim", "  none yet"));
		}
		lines.push("");
		lines.push(theme.bold(`Agents (${peer.agents.length})`));
		if (peer.agents.length === 0) lines.push(theme.fg("dim", "  none reported"));
		for (const agent of peer.agents) {
			const name = agent.displayName || agent.id;
			// The kind only adds information when the name does not already say it (`main main`).
			const kind = agent.kind && agent.kind.toLowerCase() !== name.toLowerCase() ? ` [${agent.kind}]` : "";
			// Registry lifecycle (alive/finished), not whether the agent is working right now.
			const lifecycle = agent.status ? theme.fg("dim", ` · lifecycle ${agent.status}`) : "";
			lines.push(`  ${name}${theme.fg("dim", kind)}${lifecycle}${agent.task ? ` — ${agent.task}` : ""}`);
		}
		lines.push("");
		const threads = this.#threads?.peerId === peer.instanceId ? this.#threads : undefined;
		lines.push(theme.bold(`Threads from this peer${threads?.list ? ` (${threads.list.length})` : ""}`));
		if (!threads?.list) lines.push(theme.fg("dim", "  loading…"));
		else if (threads.error) lines.push(theme.fg("error", `  ${threads.error}`));
		else if (threads.list.length === 0) lines.push(theme.fg("dim", "  none"));
		else {
			for (const thread of threads.list) {
				lines.push(
					`  ${thread.threadId} ${theme.fg("dim", `${thread.kind} · ${thread.turns} turn${thread.turns === 1 ? "" : "s"} · ${thread.status} · ${ageLabel(thread.updatedAt, now)}`)}${thread.lastQuestion ? ` — ${thread.lastQuestion}` : ""}`,
				);
			}
		}
		const truncated = lines.map(line => truncateToWidth(line, inner));
		details.scroll = Math.max(0, Math.min(details.scroll, Math.max(0, truncated.length - height)));
		return truncated.slice(details.scroll, details.scroll + height);
	}

	#renderBottom(inner: number): string[] {
		const lines: string[] = [];
		const prompt = this.#prompt;
		if (prompt?.kind === "key") {
			const title =
				prompt.step === "enter"
					? "Mesh key phrase (never stored; Enter to continue, Esc to cancel)"
					: "Repeat the key phrase (Enter to set, Esc to cancel)";
			lines.push(truncateToWidth(theme.fg("accent", title), inner));
			lines.push(prompt.input.render(inner)[0] ?? "");
			const warning = keyPhraseWarning(prompt);
			lines.push(warning ? truncateToWidth(theme.fg("warning", warning), inner) : "");
		} else if (prompt?.kind === "compose-kind") {
			const name = this.#peerName(prompt.peerId);
			lines.push(
				truncateToWidth(theme.fg("accent", `Message ${name}: choose a kind (←/→ or 1-4, Enter, Esc)`), inner),
			);
			lines.push(
				truncateToWidth(
					MESH_COMPOSE_KINDS.map((kind, index) =>
						index === prompt.index ? theme.bold(theme.fg("accent", `[${kind}]`)) : theme.fg("muted", ` ${kind} `),
					).join(" "),
					inner,
				),
			);
			lines.push(truncateToWidth(theme.fg("dim", COMPOSE_KIND_HINT[MESH_COMPOSE_KINDS[prompt.index]!]), inner));
		} else if (prompt?.kind === "compose-text") {
			const name = this.#peerName(prompt.peerId);
			lines.push(
				truncateToWidth(
					theme.fg("accent", `${prompt.composeKind} → ${name} (Enter to send, Esc to cancel)`),
					inner,
				),
			);
			lines.push(prompt.input.render(inner)[0] ?? "");
			lines.push("");
		}
		lines.push(this.#notice ? truncateToWidth(theme.fg(this.#notice.tone, this.#notice.text), inner) : "");
		for (const hint of fitMeshHints(this.#footerHints(), inner, 2)) lines.push(theme.fg("dim", hint));
		return lines;
	}

	/** Footer hints, the way out first so a narrow terminal never cuts it. */
	#footerHints(): string[] {
		if (this.#prompt) return ["esc cancel"];
		if (!this.#state.enabled) return ["esc close", "e enable", "m mode", "k key phrase"];
		const ask = this.#options.onAsk ? ["q ask"] : [];
		if (this.#details) return ["esc back", "↑↓ scroll", "c compose", ...ask, "h hide", "b block"];
		return [
			"esc close",
			"↑↓ select",
			"enter details",
			"a/d approve/deny",
			"c compose",
			...ask,
			"h hide",
			"b block",
			"v show hidden",
			"m mode",
			"k key",
			"r refresh",
			"e disable",
		];
	}

	// -- native (Tern) ---------------------------------------------------------

	/** The open key phrase or compose text prompt, which a native terminal draws as an input card. */
	#textPrompt(): KeyPrompt | ComposeTextPrompt | undefined {
		const prompt = this.#prompt;
		return prompt && prompt.kind !== "compose-kind" ? prompt : undefined;
	}

	/**
	 * A `picker` sheet where the terminal draws one; a text prompt becomes an input card in a small
	 * overlay instead. Elsewhere the manager, prompts included, stays the page `render()` draws.
	 */
	nativeSheet(cx: DescribeContext): boolean {
		this.#nativePicker = cx.supports("picker");
		return this.#nativePicker && !this.#textPrompt();
	}

	get nativeOverlay(): Component["nativeOverlay"] {
		const prompt = this.#nativePicker ? this.#textPrompt() : undefined;
		if (!prompt) return undefined;
		return prompt.kind === "key" ? KEY_PROMPT_SHEET : COMPOSE_PROMPT_SHEET;
	}

	describe(cx: DescribeContext): NativeNode | null {
		if (!cx.supports("picker")) return null;
		const prompt = this.#textPrompt();
		if (!prompt) return this.#describePicker();
		// The card replaces the picker, which comes back as a new node: rebuild its rows then, so the
		// terminal-clocked "Seen" ages restart from now instead of from before the card opened.
		this.#pickerMemo.clear();
		this.#rowsMemo.clear();
		return this.#describePrompt(prompt);
	}

	/** Pointer events run the path of the key each one stands for. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		const prompt = this.#textPrompt();
		if (prompt) {
			if (event.type !== "action" || prompt.busy) return;
			if (event.act === "submit") prompt.input.submit();
			else if (event.act === "cancel") prompt.input.onEscape?.();
			this.#options.requestRender();
			return;
		}
		const pick = pickerEvent(event);
		if (!pick) return;
		if (pick.kind === "action") this.#nativeAction(pick.act, pick.value);
		else this.#nativeItem(pick.item, pick.kind === "activate");
		this.#options.requestRender();
	}

	/** A row click selects it; activation (or any click while details are open) opens a peer's details, never approves. */
	#nativeItem(id: string, activate: boolean): void {
		if (this.#prompt) return;
		const item = this.#items().find(candidate => candidate.key === id);
		if (!item) return;
		this.#selectedKey = item.key;
		if (item.kind === "approval") this.#details = undefined;
		else if (activate || this.#details) this.#openDetails();
	}

	#nativeAction(act: string, value: string | undefined): void {
		const prompt = this.#prompt;
		if (prompt?.kind === "compose-kind") {
			if (act === "close") this.#prompt = undefined;
			else if (act === "apply") this.#openComposeText(prompt.peerId, MESH_COMPOSE_KINDS[prompt.index]!);
			else if (act === "strip") {
				const index = Number(value);
				const kind = MESH_COMPOSE_KINDS[index];
				if (!Number.isInteger(index) || !kind) return;
				prompt.index = index;
				this.#openComposeText(prompt.peerId, kind);
			}
			return;
		}
		// `close` is also Tern's backdrop and head `esc`: it leaves the details view first, like Esc.
		if (act === "close") {
			if (this.#details) this.#details = undefined;
			else this.#close();
		} else if (act === "details") {
			this.#openDetails();
		} else {
			// Every other button's id is the key it stands for; unknown ids match no key.
			this.#handleAction(act);
		}
	}

	#describePicker(): NativeNode {
		const items = this.#items();
		const selected = this.#selected(items);
		this.#selectedKey = selected?.key;
		const prompt = this.#prompt?.kind === "compose-kind" ? this.#prompt : undefined;
		// Approval expiry is the one fact Tern cannot clock; refresh it on the age tick.
		const tick = this.#state.approvals.length > 0 ? Math.floor(Date.now() / AGE_TICK_MS) : 0;
		return this.#pickerMemo.get(
			[
				this.#state,
				this.#showHidden,
				selected?.key,
				this.#details?.peerId,
				this.#threads,
				prompt,
				prompt?.index,
				this.#notice,
				tick,
			],
			() => this.#buildPicker(selected, prompt, tick),
		);
	}

	#buildPicker(
		selected: MeshManagerItem | undefined,
		prompt: Extract<Prompt, { kind: "compose-kind" }> | undefined,
		tick: number,
	): NativeNode {
		const state = this.#state;
		const base = {
			title: "Mesh",
			icon: "network",
			noun: "peers",
			size: "lg",
			layout: "rows",
			preview: "side",
			query: null,
			subtitle: prompt ? COMPOSE_KIND_HINT[MESH_COMPOSE_KINDS[prompt.index]!] : this.#statusSpans(),
			...(this.#notice ? { message: [span(this.#notice.text, this.#notice.tone)] } : {}),
		} as const;
		if (!state.enabled) {
			return picker({
				...base,
				items: [],
				empty: "The mesh is disabled. Enable it to discover omp instances on this PC (local) or your LAN (remote, with a shared key phrase) and message their agents.",
				actions: [
					pickerAction("e", "Enable", "e", { primary: true }),
					pickerAction("m", `Mode: ${state.mode}`, "m"),
					pickerAction("k", "Key phrase", "k"),
					CLOSE_ACTION,
				],
			});
		}
		const rows = this.#pickerRows(tick);
		const details = this.#details;
		return picker(
			{
				...base,
				columns: PICKER_COLUMNS,
				items: rows.items,
				order: rows.order,
				selected: selected?.key ?? null,
				strip: prompt
					? {
							label: `Message ${this.#peerName(prompt.peerId)}`,
							items: COMPOSE_KIND_CHIPS,
							selected: String(prompt.index),
						}
					: null,
				actions: prompt
					? [pickerAction("apply", "Next", "enter", { primary: true }), { ...CLOSE_ACTION, label: "Cancel" }]
					: this.#pickerActions(selected),
				focus: prompt ? "strip" : details ? "preview" : "list",
			},
			this.#describePreview(selected),
		);
	}

	/** Rows and group order, rebuilt only when the sections or the expiry tick move (not on selection). */
	#pickerRows(tick: number): PickerRows {
		const { sections } = this.#view();
		return this.#rowsMemo.get([sections, tick], () => {
			const now = Date.now();
			const items: TspPickerItem[] = [];
			const order: (string | TspPickerGroup)[] = [];
			for (const section of sections) {
				const hidden = section.hiddenCount > 0 ? ` · ${section.hiddenCount} hidden` : "";
				order.push({
					group: section.id,
					label: `${section.title}${hidden}`,
					...(section.enabled ? { count: section.items.length } : {}),
				});
				if (!section.enabled || section.items.length === 0) {
					// A placeholder row keeps the group visible; its id is no item, so events ignore it.
					const placeholder: TspPickerItem = section.enabled
						? {
								id: `none:${section.id}`,
								label: "No peers yet",
								tone: "muted",
								disabled: "Nothing discovered yet",
							}
						: {
								id: `off:${section.id}`,
								label: `Off in mode ${this.#state.mode}`,
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
		});
	}

	#pickerActions(selected: MeshManagerItem | undefined): TspPickerAction[] {
		const details = this.#details;
		const target = details ? this.#peer(details.peerId) : selected?.kind === "peer" ? selected.peer : undefined;
		const noPeer = target ? undefined : "Select a peer";
		const lead: TspPickerAction[] = details
			? []
			: selected?.kind === "approval"
				? [pickerAction("a", "Approve", "a", { primary: true }), pickerAction("d", "Deny", "d", { danger: true })]
				: [pickerAction("details", "Details", "enter", { primary: true, disabled: noPeer })];
		return [
			...lead,
			pickerAction("c", "Message", "c", { disabled: noPeer }),
			...(this.#options.onAsk
				? [pickerAction("q", "Ask", "q", { disabled: noPeer ?? (target && meshComposeRefusal(target, "ask")) })]
				: []),
			pickerAction("h", target?.hidden ? "Unhide" : "Hide", "h", { disabled: noPeer, on: target?.hidden }),
			pickerAction("b", target?.blocked ? "Unblock" : "Block", "b", {
				disabled: noPeer,
				on: target?.blocked,
				danger: true,
			}),
			pickerAction("v", "Show hidden", "v", { on: this.#showHidden }),
			pickerAction("m", `Mode: ${this.#state.mode}`, "m"),
			pickerAction("k", "Key phrase", "k"),
			pickerAction("r", "Refresh", "r"),
			pickerAction("e", "Disable", "e"),
			details ? { ...CLOSE_ACTION, label: "Back" } : CLOSE_ACTION,
		];
	}

	/** Mode, side status, LAN port, this instance and engine errors. */
	#statusSpans(): TspSpan[] {
		const state = this.#state;
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
		return parts.flatMap((part, index) => (index === 0 ? part : [span(" · ", "dim"), ...part]));
	}

	/** The details peer, else the selected row's peer or approval; keys are fixed names, never peer text. */
	#describePreview(selected: MeshManagerItem | undefined): NativeChild[] {
		const details = this.#details;
		if (details) {
			const peer = this.#peer(details.peerId);
			return peer ? this.#describePeer(peer) : [text([span("This peer is gone.", "warning")])];
		}
		if (selected?.kind === "peer") return this.#describePeer(selected.peer);
		if (selected?.kind === "approval") return describeApproval(selected.approval);
		return [];
	}

	#describePeer(peer: MeshManagerPeer): NativeChild[] {
		const facts = kv([
			["Instance", peer.instanceId],
			["Endpoint", `${peer.endpoint} (${peer.source})`],
			["State", `${peer.busy ? "busy" : "idle"} · ${peer.state}`],
			["Tags", peerTagNames(peer).join(", ")],
			["Session", peer.sessionName],
			["Cwd", peer.cwd ? shortenPath(peer.cwd) : undefined],
			["Branch", peer.branch],
			["Model", peer.model],
		]);
		const agents = peer.agents.map((agent, index) => {
			const name = agent.displayName || agent.id;
			const kind = agent.kind && agent.kind.toLowerCase() !== name.toLowerCase() ? ` [${agent.kind}]` : "";
			const spans = compact([
				span(name),
				kind ? span(kind, "dim") : undefined,
				agent.status ? span(` · lifecycle ${agent.status}`, "dim") : undefined,
				agent.task ? span(` — ${agent.task}`) : undefined,
			]);
			return node("text", { spans }, undefined, String(index));
		});
		// Peer text is plain `text`, never `md`: a peer must not get clickable links into this terminal.
		return compact<NativeChild>([
			node(
				"text",
				{ text: meshSenderLabel(peer.displayName, peer.host), role: "omp.picker.title" },
				undefined,
				"title",
			),
			facts ? keyed(facts, "facts") : undefined,
			node(
				"section",
				{ head: "Summary" },
				[peer.summary ? text(peer.summary) : text([span("none yet", "dim")])],
				"summary",
			),
			node(
				"section",
				{ head: `Agents (${peer.agents.length})` },
				agents.length > 0 ? agents : [text([span("none reported", "dim")])],
				"agents",
			),
			this.#describeThreads(peer),
		]);
	}

	/** Threads load when the details view opens; the plain preview only points there. */
	#describeThreads(peer: MeshManagerPeer): NativeNode {
		const threads = this.#details && this.#threads?.peerId === peer.instanceId ? this.#threads : undefined;
		let body: NativeChild[];
		if (!this.#details) body = [text([span("Open Details to list the threads this peer opened here.", "dim")])];
		else if (!threads?.list) body = [text([span("loading…", "dim")])];
		else if (threads.error) body = [text([span(threads.error, "error")])];
		else if (threads.list.length === 0) body = [text([span("none", "dim")])];
		else {
			body = threads.list.map((thread, index) => {
				const turns = `${thread.turns} ${pluralize("turn", thread.turns)}`;
				const spans = compact([
					span(thread.threadId, "mono"),
					span(` ${thread.kind} · ${turns} · ${thread.status}`, "dim"),
					thread.lastQuestion ? span(` — ${thread.lastQuestion}`) : undefined,
				]);
				return node("text", { spans }, undefined, String(index));
			});
		}
		const head = threads?.list ? `Threads from this peer (${threads.list.length})` : "Threads from this peer";
		return node("section", { head }, body, "threads");
	}

	#describePrompt(prompt: KeyPrompt | ComposeTextPrompt): NativeNode {
		// Only the phrase's length leaves the input: the masked `Input` describes the field itself.
		const warning = prompt.kind === "key" ? keyPhraseWarning(prompt) : undefined;
		const name = prompt.kind === "compose-text" ? this.#peerName(prompt.peerId) : undefined;
		return this.#promptMemo.get([prompt, prompt.busy, warning, name, this.#notice], () => {
			const bindings = getKeybindings();
			const submitKey = bindings.getKeys("tui.input.submit")[0];
			const cancelKey = bindings.getKeys("tui.select.cancel")[0];
			let title: string;
			let submit: string;
			if (prompt.kind === "key") {
				title =
					prompt.step === "enter"
						? "Enter the mesh key phrase. It is never stored; use the same phrase on your other machines."
						: "Repeat the key phrase.";
				submit = prompt.step === "enter" ? "Continue" : "Set key";
			} else {
				title = `${prompt.composeKind} → ${name}`;
				submit = "Send";
			}
			const notice = this.#notice;
			return col(
				compact<NativeChild>([
					node("text", { text: title, role: "omp.mesh.prompt.title" }, undefined, "title"),
					prompt.kind === "compose-text"
						? node("text", { spans: [span(COMPOSE_KIND_HINT[prompt.composeKind], "dim")] }, undefined, "hint")
						: undefined,
					prompt.input,
					warning ? node("text", { spans: [span(warning, "warning")] }, undefined, "warning") : undefined,
					notice ? node("text", { spans: [span(notice.text, notice.tone)] }, undefined, "notice") : undefined,
					actionBar([
						null,
						actionButton("Cancel", "cancel", cancelKey ? { keys: cancelKey } : {}),
						actionButton(submit, "submit", { tone: "accent", ...(submitKey ? { keys: submitKey } : {}) }),
					]),
				]),
				{ gap: "md" },
			);
		});
	}
}

interface PickerRows {
	items: TspPickerItem[];
	order: (string | TspPickerGroup)[];
}

const COMPOSE_KIND_CHIPS = MESH_COMPOSE_KINDS.map((kind, index) => ({ id: String(index), label: kind }));

const SIDE_TONE: Record<MeshManagerEngineStatus["remote"], ThemeColor> = {
	on: "success",
	off: "dim",
	"no-key": "warning",
	error: "error",
};

/** The instance id and expiry, which a renamed peer cannot spoof, outrank everything when the sheet is narrow. */
const PICKER_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "state", head: "State", priority: 2 },
	{ id: "seen", head: "Seen", format: "elapsed", priority: 1 },
	{ id: "instance", head: "Instance", format: "dim", priority: 4 },
	{ id: "expires", head: "Expires", priority: 3 },
];

const KEY_PROMPT_SHEET = { role: "omp.overlay.mesh", size: "md", anchor: "center", head: "Mesh key phrase" } as const;
const COMPOSE_PROMPT_SHEET = { role: "omp.overlay.mesh", size: "md", anchor: "center", head: "Mesh message" } as const;

function keyPhraseWarning(prompt: KeyPrompt): string | undefined {
	const length = (prompt.step === "enter" ? prompt.input.getValue() : prompt.first).length;
	if (length > 0 && length < MESH_REQUIRED_KEY_PHRASE_CHARS) {
		return `Too short: the mesh requires at least ${MESH_REQUIRED_KEY_PHRASE_CHARS} characters.`;
	}
	if (length > 0 && length < MESH_MIN_KEY_PHRASE_CHARS) {
		return `Short phrases are guessable by anyone on your LAN; use ${MESH_MIN_KEY_PHRASE_CHARS}+ characters.`;
	}
	return undefined;
}

/** The claimed sender, capped so it can never crowd the unspoofable instance id and expiry off a row. */
function approvalSender(approval: MeshManagerApproval): string {
	return truncateToWidth(meshSenderLabel(approval.fromName, approval.fromHost), APPROVAL_FROM_CELLS);
}

/** The one-line head of a peer's summary; only that much of a (possibly 64 KiB) summary is ever measured. */
function rowSummary(peer: MeshManagerPeer): string | undefined {
	return peer.summary
		? truncateToWidth(peer.summary.slice(0, ROW_SUMMARY_CELLS * 2).replaceAll("\n", " "), ROW_SUMMARY_CELLS)
		: undefined;
}

function peerTagNames(peer: MeshManagerPeer): string[] {
	return compact([peer.state === "stale" && "stale", peer.hidden && "hidden", peer.blocked && "blocked"]);
}

function approvalPickerItem(item: Extract<MeshManagerItem, { kind: "approval" }>, now: number): TspPickerItem {
	const { approval } = item;
	return {
		id: item.key,
		label: [span(approval.kind, "warning strong"), span(" from "), span(approvalSender(approval))],
		detail: truncateToWidth(approval.preview, ROW_SUMMARY_CELLS),
		dot: "warning",
		facts: { instance: approval.fromInstanceId, expires: `in ${remainingLabel(approval.expiresAt, now)}` },
	};
}

function peerPickerItem(item: Extract<MeshManagerItem, { kind: "peer" }>, now: number): TspPickerItem {
	const { peer } = item;
	const detail = compact([peer.sessionName, rowSummary(peer)]).join(" — ");
	return {
		id: item.key,
		label: meshSenderLabel(peer.displayName, peer.host),
		...(detail ? { detail } : {}),
		dot: peer.state === "online" ? "success" : "muted",
		badges: peerTagNames(peer).map(tag => ({
			text: tag,
			tone: tag === "blocked" ? ("error" as const) : ("muted" as const),
		})),
		...(peer.hidden || peer.blocked ? { tone: "muted" as const } : {}),
		facts: {
			state: peer.busy ? [span("busy", "warning")] : [span("idle", "success")],
			seen: Math.max(0, now - peer.lastSeen),
		},
	};
}

function describeApproval(approval: MeshManagerApproval): NativeChild[] {
	const facts = kv([
		["Instance", approval.fromInstanceId],
		["From", approvalSender(approval)],
		["Agent", truncateToWidth(approval.fromAgent, APPROVAL_AGENT_CELLS)],
		["Expires", `in ${remainingLabel(approval.expiresAt, Date.now())}`],
	]);
	return compact<NativeChild>([
		node("text", { text: `${approval.kind} request`, role: "omp.picker.title" }, undefined, "title"),
		facts ? keyed(facts, "facts") : undefined,
		node("section", { head: "Request" }, [text(approval.preview)], "request"),
	]);
}

const COMPOSE_KIND_HINT: Record<MeshComposeKind, string> = {
	status: "status: a quick side answer about what the peer is doing (no tools)",
	ask: "ask: a read-only question the peer answers from a forked context",
	steer: "steer: a message into the peer's main agent context",
	note: "note: shown to the peer's human only; nothing answers it",
};

function busyLabel(busy: boolean): string {
	return busy ? theme.fg("warning", "busy") : theme.fg("success", "idle");
}

function peerTags(peer: MeshManagerPeer): string {
	const tags = peerTagNames(peer);
	return tags.length > 0 ? theme.fg(peer.blocked ? "error" : "dim", ` [${tags.join(", ")}]`) : "";
}

/** Two rows per (sanitized) peer: identity and run state, then where it works and what it does. */
function peerRows(peer: MeshManagerPeer, selected: boolean, inner: number, now: number): string[] {
	const sep = theme.fg("dim", " · ");
	const dot = peer.state === "online" ? theme.fg("success", "●") : theme.fg("dim", "○");
	const head = [
		`${dot} ${selected ? theme.bold(peer.displayName) : peer.displayName}${peerTags(peer)}`,
		peer.sessionName ? theme.fg("text", peer.sessionName) : undefined,
		theme.fg("muted", peer.endpoint),
		busyLabel(peer.busy),
		theme.fg("dim", ageLabel(peer.lastSeen, now)),
	]
		.filter(part => part !== undefined)
		.join(sep);
	const facts = [
		peer.cwd ? shortenPath(peer.cwd) : undefined,
		peer.branch ? `⎇ ${peer.branch}` : undefined,
		peer.model,
	]
		.filter(part => part !== undefined)
		.join(" · ");
	const tail = [facts, rowSummary(peer)].filter(Boolean).join(" — ");
	const dim = peer.hidden || peer.blocked;
	const prefix = selected ? theme.fg("accent", "› ") : "  ";
	const rows = [`${prefix}${head}`, `    ${theme.fg("dim", tail)}`];
	return rows.map(line => truncateToWidth(dim && !selected ? theme.fg("dim", Bun.stripANSI(line)) : line, inner));
}

/**
 * A (sanitized) approval: the instance id (which renaming cannot spoof) and expiry lead the header,
 * so the self-declared name, host and agent (capped) can never push them off screen; the selected
 * row wraps the request preview (already bounded by the approval queue) over a few rows.
 */
function approvalRows(approval: MeshManagerApproval, selected: boolean, inner: number, now: number): string[] {
	const from = approvalSender(approval);
	const agent = truncateToWidth(approval.fromAgent, APPROVAL_AGENT_CELLS);
	const meta = `${approval.fromInstanceId} · expires in ${remainingLabel(approval.expiresAt, now)}`;
	const head = `${theme.fg("warning", approval.kind)} ${theme.fg("dim", meta)} · from ${selected ? theme.bold(from) : from} ${theme.fg("dim", `(${agent})`)}`;
	const prefix = selected ? theme.fg("accent", "› ") : "  ";
	const rows = [truncateToWidth(`${prefix}${head}`, inner)];
	if (!selected) {
		rows.push(truncateToWidth(`    ${theme.fg("dim", approval.preview)}`, inner));
		return rows;
	}
	const wrapped = wrapTextWithAnsi(approval.preview, Math.max(1, inner - 4));
	const shown = wrapped.slice(0, APPROVAL_PREVIEW_ROWS);
	if (wrapped.length > shown.length) shown[shown.length - 1] = `${shown.at(-1)}…`;
	for (const line of shown) rows.push(truncateToWidth(`    ${line}`, inner));
	rows.push(truncateToWidth(`    ${theme.fg("dim", "a approve · d deny")}`, inner));
	return rows;
}
