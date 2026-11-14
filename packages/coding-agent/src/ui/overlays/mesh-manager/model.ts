/**
 * The `/mesh` manager's live state and actions behind {@link MeshManager}: the sanitized runtime
 * state (pulled coalesced on every runtime change), selection, the details view and its threads,
 * the open prompt (key phrase, compose kind, compose text), the notice, and every key or Tern event.
 * Views read {@link MeshManagerModel.rev} and the view getters; nothing here draws.
 */
import { type KeyEvent, signal, type TextEdit, type UiEvent } from "@oh-my-pi/pi-tui";
import { toError } from "@oh-my-pi/pi-utils";
import type { TspPickerItem, TspPickerProps, TspSpan } from "@oh-my-pi/pi-wire";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { listKeyId, matchesSelectCancel } from "../../../config/keybindings/matchers";
import { meshComposeRefusal, meshDisplayText } from "../../../modes/view-model/overlays/mesh-display";
import {
	buildMeshManagerSections,
	MESH_AGE_TICK_MS,
	MESH_CHANGE_COALESCE_MS,
	MESH_COMPOSE_KIND_HINT,
	MESH_DISABLED_ROWS,
	MESH_PICKER_COLUMNS,
	type MeshActionContext,
	type MeshDoc,
	type MeshManagerItem,
	type MeshManagerSection,
	type MeshRow,
	meshApprovalDoc,
	meshCloseAction,
	meshDocRows,
	meshFooterHints,
	meshHeaderRows,
	meshKeyPhraseWarning,
	meshListRows,
	meshManagerItems,
	meshPeerDoc,
	meshPickerActions,
	meshPickerRows,
	meshStatusSpans,
	type MeshThreadsView,
	nextMeshMode,
	sanitizeMeshManagerState,
	sanitizeMeshThreads,
} from "../../../modes/view-model/overlays/mesh-manager";
import {
	MESH_COMPOSE_KINDS,
	type MeshComposeKind,
	type MeshManagerPeer,
	type MeshManagerRuntime,
	type MeshManagerState,
	type MeshManagerThread,
} from "../../../modes/view-model/overlays/mesh-manager-types";
import { editLine } from "../settings/line-edit";
import { applyEdit, applyMaskedEdit, type LineValue } from "../panels/common";

export interface MeshManagerOptions {
	onClose(): void;
	/** Ask `instanceId` a side question; set to offer the `q` / "Ask" action. The manager closes first. */
	onAsk?(instanceId: string): void;
	/** The clock ages and expiries are measured against (default `Date.now`). */
	now?(): number;
}

type KeyPrompt = { kind: "key"; step: "enter" | "confirm"; first: string; line: LineValue; busy: boolean };
type ComposeTextPrompt = {
	kind: "compose-text";
	peerId: string;
	composeKind: MeshComposeKind;
	line: LineValue;
	busy: boolean;
};
type ComposeKindPrompt = { kind: "compose-kind"; peerId: string; index: number };
type Prompt = KeyPrompt | ComposeKindPrompt | ComposeTextPrompt;

type NoticeTone = "success" | "warning" | "error" | "muted";

interface Notice {
	tone: NoticeTone;
	text: string;
}

/** The open key-phrase or compose-text prompt as the views draw it; the key phrase only as bullets. */
export interface MeshTextPromptView {
	readonly kind: "key" | "compose-text";
	readonly title: string;
	/** The compose kind's explanation. */
	readonly hint?: string;
	/** The field's shown text (bullets for the key phrase) and caret in it. */
	readonly text: string;
	readonly cursor: number;
	readonly warning?: string;
	readonly submit: string;
	readonly busy: boolean;
}

/** What the picker's preview shows: a document, a gone peer, the open text prompt, or nothing. */
export type MeshPreview =
	| { readonly kind: "doc"; readonly doc: MeshDoc }
	| { readonly kind: "gone" }
	| { readonly kind: "prompt"; readonly prompt: MeshTextPromptView; readonly notice?: TspSpan }
	| { readonly kind: "none" };

/** The terminal page the `omp.mesh` look fits to the screen. */
export interface MeshPage {
	readonly header: readonly MeshRow[];
	readonly body: readonly MeshRow[];
	/** List page: body rows of the selected item, kept on screen. */
	readonly selection?: { readonly start: number; readonly end: number };
	/** Details page: the scroll offset in drawn rows; the look reports the offset it could show. */
	readonly scroll?: { readonly offset: number; clamp(offset: number): void };
	readonly bottom: readonly MeshRow[];
	readonly hints: readonly string[];
}

/** The manager picker's `term` facts: the look builds the page from the model; `rev` repaints it. */
export type MeshLookTerm = { readonly look: "omp.mesh"; readonly model: MeshManagerModel; readonly rev: number };

/** Mask of a secret value, one bullet per character. */
const mask = (text: string) => "•".repeat(Array.from(text).length);

export class MeshManagerModel {
	/** Bumped on every change the views draw. */
	readonly rev = signal(0);
	readonly #runtime: MeshManagerRuntime;
	readonly #options: MeshManagerOptions;
	readonly #now: () => number;
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
	#disposed = false;
	#view: { state: MeshManagerState; showHidden: boolean; sections: MeshManagerSection[]; items: MeshManagerItem[] };

	constructor(runtime: MeshManagerRuntime, options: MeshManagerOptions) {
		this.#runtime = runtime;
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#state = sanitizeMeshManagerState(runtime.getState());
		this.#view = this.#buildView();
		this.#selectedKey = this.#view.items[0]?.key;
		this.#unsubscribe = runtime.subscribe(() => this.#scheduleChange());
		this.#tick = setInterval(() => this.#touch(), MESH_AGE_TICK_MS);
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

	#touch(): void {
		this.rev.set(this.rev.peek() + 1);
	}

	// -- data ------------------------------------------------------------------

	#scheduleChange(): void {
		if (this.#disposed || this.#changeTimer) return;
		this.#changeTimer = setTimeout(() => {
			this.#changeTimer = undefined;
			this.#pull();
		}, MESH_CHANGE_COALESCE_MS);
		this.#changeTimer.unref?.();
	}

	#pull(): void {
		if (this.#disposed) return;
		this.#state = sanitizeMeshManagerState(this.#runtime.getState());
		if (this.#details) this.#loadThreads(this.#details.peerId);
		this.#touch();
	}

	#loadThreads(peerId: string): void {
		const generation = ++this.#threadsGeneration;
		if (this.#threads?.peerId !== peerId) this.#threads = { peerId, list: undefined };
		this.#runtime.listThreads(peerId).then(
			list => {
				if (this.#disposed || generation !== this.#threadsGeneration) return;
				this.#threads = { peerId, list: sanitizeMeshThreads(list) };
				this.#touch();
			},
			(error: unknown) => {
				if (this.#disposed || generation !== this.#threadsGeneration) return;
				this.#threads = { peerId, list: [], error: meshDisplayText(toError(error).message) };
				this.#touch();
			},
		);
	}

	/** Notices can carry peer or engine text; sanitized once here. */
	#notify(tone: NoticeTone, text: string): void {
		this.#notice = { tone, text: meshDisplayText(text) };
	}

	#buildView() {
		const sections = buildMeshManagerSections(this.#state, this.#showHidden);
		return { state: this.#state, showHidden: this.#showHidden, sections, items: meshManagerItems(sections) };
	}

	/** Sections and their selectable items, rebuilt only when the state or the hidden toggle changes. */
	#sections(): { sections: MeshManagerSection[]; items: MeshManagerItem[] } {
		if (this.#view.state !== this.#state || this.#view.showHidden !== this.#showHidden)
			this.#view = this.#buildView();
		return this.#view;
	}

	/** The selected row; the first row stands in while the selected one is gone. */
	#selected(items = this.#sections().items): MeshManagerItem | undefined {
		return items.find(item => item.key === this.#selectedKey) ?? items[0];
	}

	/** The selection as a view draws it: a drawn fallback becomes the selection, so `a`/`d` resolve what is shown. */
	#drawnSelection(): MeshManagerItem | undefined {
		const selected = this.#selected();
		this.#selectedKey = selected?.key;
		return selected;
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

	/** The peer an action applies to: the one in details, else the selected row's. */
	#targetPeer(): MeshManagerPeer | undefined {
		return this.#details ? this.#peer(this.#details.peerId) : this.#selectedPeer();
	}

	// -- keys --------------------------------------------------------------------

	/** A key on the manager; every press is the manager's. */
	key(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		if (this.#disposed) return true;
		if (key.id === "ctrl+c") {
			this.#close();
			return true;
		}
		if (this.#prompt) this.#promptKey(this.#prompt, key);
		else if (this.#details) this.#detailsKey(this.#details, key);
		else this.#listKey(key);
		this.#touch();
		return true;
	}

	#listKey(key: KeyEvent): void {
		const id = listKeyId(key);
		if (id === "escape") this.#close();
		else if (id === "up") this.#move(-1);
		else if (id === "down") this.#move(1);
		else if (id === "enter") this.#openDetails();
		else this.#handleAction(id);
	}

	#detailsKey(details: { peerId: string; scroll: number }, key: KeyEvent): void {
		const id = listKeyId(key);
		if (id === "escape" || id === "enter") this.#details = undefined;
		else if (id === "up") details.scroll = Math.max(0, details.scroll - 1);
		else if (id === "down") details.scroll++;
		else this.#handleAction(id);
	}

	#promptKey(prompt: Prompt, key: KeyEvent): void {
		if (prompt.kind === "compose-kind") {
			const id = listKeyId(key);
			if (id === "escape") this.#prompt = undefined;
			else if (id === "left") prompt.index = Math.max(0, prompt.index - 1);
			else if (id === "right") prompt.index = Math.min(MESH_COMPOSE_KINDS.length - 1, prompt.index + 1);
			else if (id === "enter") this.#openComposeText(prompt.peerId, MESH_COMPOSE_KINDS[prompt.index]!);
			else {
				const digit = /^[1-9]$/.test(id) ? Number(id) : 0;
				if (digit >= 1 && digit <= MESH_COMPOSE_KINDS.length)
					this.#openComposeText(prompt.peerId, MESH_COMPOSE_KINDS[digit - 1]!);
			}
			return;
		}
		if (prompt.busy) return;
		if (matchesSelectCancel(key)) this.#prompt = undefined;
		else if (getKeybindings().matches(key, "tui.input.submit")) this.#submitPrompt(prompt);
		else {
			const next = editLine(prompt.line, key);
			if (next) prompt.line = next;
		}
	}

	/** A paste into the open text prompt, on one line. */
	paste(text: string): boolean {
		const prompt = this.#textPrompt();
		if (!prompt || prompt.busy) return true;
		const clean = text.replace(/[\r\n]+/g, "");
		const { text: value, cursor } = prompt.line;
		prompt.line = { text: `${value.slice(0, cursor)}${clean}${value.slice(cursor)}`, cursor: cursor + clean.length };
		this.#touch();
		return true;
	}

	/** Actions shared by the list, the details view and Tern's buttons (whose ids are these keys); unknown ids do nothing. */
	#handleAction(id: string): void {
		if (id === "e") this.#toggleEnabled();
		else if (id === "m") this.#cycleMode();
		else if (id === "k") this.#openKeyPrompt();
		else if (id === "r") this.#refresh();
		else if (!this.#state.enabled) return;
		else if (id === "v") {
			this.#showHidden = !this.#showHidden;
			this.#notify("muted", this.#showHidden ? "Showing hidden peers" : "Hiding hidden peers");
		} else if (id === "a" || id === "d") {
			// Approvals are decided from the list only; the details view shows a peer, never a request.
			if (!this.#details) this.#decide(id === "a");
		} else if (id === "h") this.#toggleFlag("hidden");
		else if (id === "b") this.#toggleFlag("blocked");
		else if (id === "c") this.#openCompose();
		else if (id === "q" && this.#options.onAsk) this.#ask(this.#options.onAsk);
	}

	#move(delta: number): void {
		const items = this.#sections().items;
		if (items.length === 0) return;
		const current = this.#selected(items);
		const index = current ? items.indexOf(current) : 0;
		this.#selectedKey = items[Math.max(0, Math.min(items.length - 1, index + delta))]?.key;
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
			this.#notify("error", toError(error).message);
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
		const mode = nextMeshMode(this.#state.mode);
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
		const item = this.#sections().items.find(candidate => candidate.key === this.#selectedKey);
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

	#openKeyPrompt(step: KeyPrompt["step"] = "enter", first = ""): void {
		this.#prompt = { kind: "key", step, first, line: { text: "", cursor: 0 }, busy: false };
	}

	#submitPrompt(prompt: KeyPrompt | ComposeTextPrompt): void {
		if (prompt.kind === "key") void this.#submitKey(prompt, prompt.line.text);
		else void this.#submitCompose(prompt, prompt.line.text);
	}

	async #submitKey(prompt: KeyPrompt, phrase: string): Promise<void> {
		if (prompt.step === "enter") {
			if (phrase.trim().length === 0) {
				this.#notify("error", "The key phrase cannot be blank");
			} else {
				this.#notice = undefined;
				this.#openKeyPrompt("confirm", phrase);
			}
			return;
		}
		if (phrase !== prompt.first) {
			this.#notify("error", "The phrases do not match; enter it again");
			this.#openKeyPrompt();
			return;
		}
		prompt.busy = true;
		this.#notify("muted", "Deriving the mesh key…");
		this.#touch();
		try {
			await this.#runtime.setKeyPhrase(phrase);
			if (this.#disposed) return;
			this.#notify("success", "Mesh key set; use the same phrase on your other machines");
			this.#prompt = undefined;
			this.#pull();
		} catch (error) {
			if (this.#disposed) return;
			this.#notify("error", `Key not set: ${toError(error).message}`);
			this.#openKeyPrompt();
			this.#touch();
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
		this.#prompt = { kind: "compose-text", peerId, composeKind, line: { text: "", cursor: 0 }, busy: false };
	}

	async #submitCompose(prompt: ComposeTextPrompt, text: string): Promise<void> {
		if (text.trim().length === 0) return;
		const name = this.#peerName(prompt.peerId);
		prompt.busy = true;
		this.#notify("muted", `Sending ${prompt.composeKind} to ${name}…`);
		this.#touch();
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
			notice = { tone: "error", text: `Not sent: ${toError(error).message}` };
		}
		if (this.#disposed) return;
		this.#notify(notice.tone, notice.text);
		if (notice.tone === "success") this.#prompt = undefined;
		else prompt.busy = false;
		this.#touch();
	}

	// -- Tern events ---------------------------------------------------------------

	/** A picker event: rows, buttons, chips, and edits of the prompt's field. */
	event(event: UiEvent): void {
		if (this.#disposed) return;
		const prompt = this.#textPrompt();
		if (prompt) {
			if (prompt.busy) return;
			if (event.type === "action") {
				if (event.act === "submit") this.#submitPrompt(prompt);
				else if (event.act === "close") this.#prompt = undefined;
			} else if (event.type === "edit") this.#edit(prompt, event);
			else return;
		} else if (event.type === "action") this.#nativeAction(event.act, event.value);
		else if (event.type === "select" || event.type === "activate")
			this.#nativeItem(event.item, event.type === "activate");
		else return;
		this.#touch();
	}

	/** An edit of the field as drawn: the key phrase's offsets count bullets. */
	#edit(prompt: KeyPrompt | ComposeTextPrompt, edit: TextEdit): void {
		const next = prompt.kind === "key" ? applyMaskedEdit(prompt.line, edit) : applyEdit(prompt.line, edit);
		if (next) prompt.line = next;
	}

	/** A row click selects it; activation (or any click while details are open) opens a peer's details, never approves. */
	#nativeItem(id: string, activate: boolean): void {
		if (this.#prompt) return;
		const item = this.#sections().items.find(candidate => candidate.key === id);
		if (!item) return;
		this.#selectedKey = item.key;
		if (item.kind === "approval") this.#details = undefined;
		else if (activate || this.#details) this.#openDetails();
	}

	#nativeAction(act: string, value: unknown): void {
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
		} else if (act === "details") this.#openDetails();
		else this.#handleAction(act);
	}

	// -- views ---------------------------------------------------------------------

	#textPrompt(): KeyPrompt | ComposeTextPrompt | undefined {
		const prompt = this.#prompt;
		return prompt && prompt.kind !== "compose-kind" ? prompt : undefined;
	}

	#actionContext(selected: MeshManagerItem | undefined): MeshActionContext {
		return {
			state: this.#state,
			details: this.#details !== undefined,
			prompt: this.#prompt !== undefined,
			target: this.#targetPeer(),
			selected,
			showHidden: this.#showHidden,
			canAsk: this.#options.onAsk !== undefined,
		};
	}

	#noticeSpan(): TspSpan | undefined {
		return this.#notice && { t: this.#notice.text, s: this.#notice.tone };
	}

	#promptView(prompt: KeyPrompt | ComposeTextPrompt): MeshTextPromptView {
		if (prompt.kind === "key") {
			const phrase = prompt.step === "enter" ? prompt.line.text : prompt.first;
			const warning = meshKeyPhraseWarning(phrase);
			return {
				kind: "key",
				title:
					prompt.step === "enter"
						? "Enter the mesh key phrase. It is never stored; use the same phrase on your other machines."
						: "Repeat the key phrase.",
				text: mask(prompt.line.text),
				cursor: Array.from(prompt.line.text.slice(0, prompt.line.cursor)).length,
				...(warning ? { warning } : {}),
				submit: prompt.step === "enter" ? "Continue" : "Set key",
				busy: prompt.busy,
			};
		}
		return {
			kind: "compose-text",
			title: `${prompt.composeKind} → ${this.#peerName(prompt.peerId)}`,
			hint: MESH_COMPOSE_KIND_HINT[prompt.composeKind],
			text: prompt.line.text,
			cursor: prompt.line.cursor,
			submit: "Send",
			busy: prompt.busy,
		};
	}

	/** The picker's props (everything but its preview). */
	pickerView(): Partial<TspPickerProps> {
		const state = this.#state;
		const selected = this.#drawnSelection();
		const notice = this.#noticeSpan();
		const prompt = this.#prompt;
		const text = this.#textPrompt();
		let actions = meshPickerActions(this.#actionContext(selected));
		if (prompt?.kind === "compose-kind")
			actions = [{ id: "apply", label: "Next", keys: ["enter"], primary: true }, meshCloseAction("Cancel")];
		else if (text) {
			const view = this.#promptView(text);
			actions = [
				{
					id: "submit",
					label: view.submit,
					keys: ["enter"],
					primary: true,
					...(text.busy ? { disabled: true } : {}),
				},
				meshCloseAction("Cancel"),
			];
		}
		const base: Partial<TspPickerProps> = {
			subtitle:
				prompt?.kind === "compose-kind"
					? MESH_COMPOSE_KIND_HINT[MESH_COMPOSE_KINDS[prompt.index]!]
					: meshStatusSpans(state),
			...(notice ? { message: [notice] } : {}),
			actions,
			focus: prompt?.kind === "compose-kind" ? "strip" : text || this.#details ? "preview" : "list",
		};
		if (!state.enabled) {
			return {
				...base,
				items: [],
				order: [],
				selected: null,
				empty: "The mesh is disabled. Enable it to discover omp instances on this PC (local) or your LAN (remote, with a shared key phrase) and message their agents.",
				strip: null,
			};
		}
		const rows = meshPickerRows(this.#sections().sections, state.mode, this.#now());
		return {
			...base,
			columns: MESH_PICKER_COLUMNS,
			items: rows.items as TspPickerItem[],
			order: rows.order,
			selected: selected?.key ?? null,
			strip:
				prompt?.kind === "compose-kind"
					? {
							label: `Message ${this.#peerName(prompt.peerId)}`,
							items: MESH_COMPOSE_KINDS.map((kind, index) => ({ id: String(index), label: kind })),
							selected: String(prompt.index),
						}
					: null,
		};
	}

	/** The picker's preview: the open text prompt, else the details peer, else the selected row's peer or approval. */
	preview(): MeshPreview {
		const text = this.#textPrompt();
		if (text) {
			const notice = this.#noticeSpan();
			return { kind: "prompt", prompt: this.#promptView(text), ...(notice ? { notice } : {}) };
		}
		if (!this.#state.enabled) return { kind: "none" };
		const details = this.#details;
		const selected = this.#selected();
		const peer = details ? this.#peer(details.peerId) : selected?.kind === "peer" ? selected.peer : undefined;
		if (peer) return { kind: "doc", doc: meshPeerDoc(peer, this.#threadsFor(peer.instanceId)) };
		if (details) return { kind: "gone" };
		if (selected?.kind === "approval") return { kind: "doc", doc: meshApprovalDoc(selected.approval, this.#now()) };
		return { kind: "none" };
	}

	/** The details peer's threads; undefined outside details (the preview only points there). */
	#threadsFor(peerId: string): MeshThreadsView | undefined {
		if (this.#details?.peerId !== peerId) return undefined;
		const threads = this.#threads?.peerId === peerId ? this.#threads : undefined;
		return threads?.list ? { list: threads.list, ...(threads.error ? { error: threads.error } : {}) } : {};
	}

	/** The terminal page (look `omp.mesh`): header, list or details body, prompt rows, notice and hints. */
	page(): MeshPage {
		const state = this.#state;
		const now = this.#now();
		const selected = this.#drawnSelection();
		const details = this.#details;
		let body: readonly MeshRow[];
		let selection: MeshPage["selection"];
		let scroll: MeshPage["scroll"];
		if (details) {
			const peer = this.#peer(details.peerId);
			body = peer
				? meshDocRows(meshPeerDoc(peer, this.#threadsFor(peer.instanceId), now))
				: [{ spans: [{ t: "This peer is gone.", s: "warning" }] }, { spans: [{ t: "Esc to go back", s: "dim" }] }];
			scroll = {
				offset: details.scroll,
				clamp: offset => {
					details.scroll = offset;
				},
			};
		} else if (!state.enabled) {
			body = MESH_DISABLED_ROWS;
		} else {
			const list = meshListRows(this.#sections().sections, selected?.key, now);
			body = list.rows;
			selection = list.selected;
		}
		const notice = this.#noticeSpan();
		return {
			header: meshHeaderRows(state),
			body,
			...(selection ? { selection } : {}),
			...(scroll ? { scroll } : {}),
			bottom: [...this.#promptRows(), { spans: notice ? [notice] : [] }],
			hints: meshFooterHints(this.#actionContext(selected)),
		};
	}

	/** The open prompt's rows on the terminal page. */
	#promptRows(): MeshRow[] {
		const prompt = this.#prompt;
		if (!prompt) return [];
		if (prompt.kind === "compose-kind") {
			const name = this.#peerName(prompt.peerId);
			const chips: TspSpan[] = MESH_COMPOSE_KINDS.flatMap((kind, index) => [
				...(index > 0 ? [{ t: " " }] : []),
				index === prompt.index ? { t: `[${kind}]`, s: "strong accent" } : { t: ` ${kind} `, s: "muted" },
			]);
			return [
				{ spans: [{ t: `Message ${name}: choose a kind (←/→ or 1-4, Enter, Esc)`, s: "accent" }] },
				{ spans: chips },
				{ spans: [{ t: MESH_COMPOSE_KIND_HINT[MESH_COMPOSE_KINDS[prompt.index]!], s: "dim" }] },
			];
		}
		const view = this.#promptView(prompt);
		const title =
			prompt.kind === "compose-text"
				? `${view.title} (Enter to send, Esc to cancel)`
				: prompt.step === "enter"
					? "Mesh key phrase (never stored; Enter to continue, Esc to cancel)"
					: "Repeat the key phrase (Enter to set, Esc to cancel)";
		return [
			{ spans: [{ t: title, s: "accent" }] },
			{ spans: [], field: { text: view.text, cursor: view.cursor } },
			{ spans: view.warning ? [{ t: view.warning, s: "warning" }] : [] },
		];
	}
}
