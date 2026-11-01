/**
 * `/ask`: a /btw-style side conversation answered by another omp instance over the mesh.
 * Each conversation is one mesh `ask` thread with one peer (a read-only fork of its session);
 * follow-ups continue the thread. The dialog reuses the BTW history panel (text and native).
 *
 * `/ask <peer> <message>` sends the question and opens the dialog on its thread, like `/btw <question>`.
 * An answer nobody waits for any more (stopped, timed out) lands as a `MESH` transcript card and is
 * folded into its conversation, so `/ask <peer>` shows it.
 */
import type { OverlayHandle } from "@oh-my-pi/pi-tui";
import type { BtwHistoryRecord, BtwHistoryTurn } from "@oh-my-pi/pi-tui/overlays/btw-history";
import { getBtwCopyText, getBtwLatestTurn } from "@oh-my-pi/pi-tui/overlays/btw-history";
import type { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import { meshDisplayText } from "@oh-my-pi/pi-tui/overlays/mesh-display";
import { disambiguateDisplayLabels } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import { toError } from "@oh-my-pi/pi-utils";
import { MeshEngineError, type MeshIncomingReply, type MeshPeerView } from "../../mesh/engine";
import { MESH_SEND_MAX_TIMEOUT_SEC, MESH_USER_AGENT_ID, type MeshSendResult } from "../../mesh/outbound";
import { resolveMeshPeer, visibleMeshPeers } from "../../mesh/peers";
import { getMeshRuntime, type MeshRuntime } from "../../mesh/runtime";
import type { MeshSender, MeshSnapshot } from "../../mesh/wire";
import { beginBtwTurn, patchLatestBtwTurn } from "../../session/btw-turn";
import { parseSubcommand } from "../../slash-commands/helpers/parse";
import type { InteractiveModeContext } from "../types";
import { copyBtwAnswer, showBtwHistorySheet } from "./btw-controller";

/** Display fields of a peer for cards and headings; peer-declared, sanitized where rendered. */
type MeshAskPeer = Pick<MeshSender, "instanceId" | "displayName" | "host"> & { sessionName?: string };

interface MeshAskConversation {
	peer: MeshAskPeer;
	record: BtwHistoryRecord;
	/** Mesh thread id from the first acknowledgement; follow-ups continue it. */
	thread?: string;
	/** msgId of the latest turn: its answer (waited for or late) completes that turn. */
	msgId: string;
	/** A question is between send and acknowledgement; another must not overtake it. */
	sending: boolean;
	/** The latest turn's answer is being waited for; aborting stops waiting only (mesh has no remote cancel). */
	wait?: AbortController;
}

interface MeshAskDialog {
	peerId: string;
	panel: BtwHistoryPanel;
	overlay: OverlayHandle;
}

function peerOf(view: MeshPeerView, snapshot: MeshSnapshot): MeshAskPeer {
	return {
		instanceId: view.instanceId,
		displayName: snapshot.displayName,
		host: snapshot.host,
		sessionName: snapshot.sessionName ?? undefined,
	};
}

/** `session — name (id8)`: how a peer is picked and headed; peer text sanitized. */
function peerTitle(peer: MeshAskPeer): string {
	const name = meshDisplayText(peer.displayName) || peer.instanceId;
	const session = meshDisplayText(peer.sessionName);
	const id = peer.instanceId.slice(0, 8);
	return session ? `${session} — ${name} (${id})` : `${name} (${id})`;
}

export class MeshAskController {
	readonly #conversations: MeshAskConversation[] = [];
	#dialog: MeshAskDialog | undefined;
	#copyInFlight = false;

	constructor(private readonly ctx: InteractiveModeContext) {}

	/** `/ask [peer [message]]`; false when nothing was sent or opened, so the draft comes back. */
	async handleCommand(args: string): Promise<boolean> {
		const runtime = this.#runtime();
		if (!runtime) return false;
		const { verb: query, rest: message } = parseSubcommand(args);
		if (!query) {
			const picked = await this.#pickPeer(runtime);
			// A dismissed picker is a choice, not a failure: a bare `/ask` is not worth restoring.
			return picked ? this.openForPeer(picked) : true;
		}
		const resolution = resolveMeshPeer(runtime.engine.peers(), query);
		if (!resolution.ok) {
			this.ctx.showError(sanitizeErrorLine(resolution.message));
			return false;
		}
		// `resolveMeshPeer` only returns peers that served a snapshot.
		const peer = peerOf(resolution.peer, resolution.peer.snapshot!);
		if (!message) return this.#open(peer);
		// Open only once the peer accepted the question; a refusal keeps the draft instead.
		return (await this.#send(peer, message)) && this.#open(peer);
	}

	/** Open the conversation dialog with one peer (the picker, the `/mesh` Ask action). */
	openForPeer(instanceId: string): boolean {
		const runtime = this.#runtime();
		if (!runtime) return false;
		const view = this.#liveView(runtime, instanceId, "That mesh peer");
		return view ? this.#open(peerOf(view, view.snapshot!)) : false;
	}

	/** The peer's live view; `undefined`, with an error shown, once it left or never served a snapshot. */
	#liveView(runtime: MeshRuntime, instanceId: string, title: string): MeshPeerView | undefined {
		const view = runtime.engine.peers().find(peer => peer.instanceId === instanceId);
		if (view?.snapshot) return view;
		this.ctx.showError(`${title} is no longer available.`);
		return undefined;
	}

	dispose(): void {
		for (const conversation of this.#conversations) conversation.wait?.abort();
		this.#closeDialog();
	}

	#runtime(): MeshRuntime | undefined {
		const runtime = getMeshRuntime();
		if (!runtime) this.ctx.showError("The mesh is not running. Enable it in /mesh (press e).");
		return runtime;
	}

	#open(peer: MeshAskPeer): boolean {
		this.#closeDialog();
		const records = this.#records(peer.instanceId);
		const { panel, overlay } = showBtwHistorySheet(this.ctx, {
			records,
			texts: {
				heading: `Ask ${peerTitle(peer)}`,
				role: "omp.overlay.meshAsk",
				emptyTitle: "No questions to this agent yet",
				emptyHint: "Type a question; the agent answers from its session without changing it.",
				followUpPlaceholder: "Ask a follow-up in this thread…",
				startPlaceholder: "Ask this agent…",
				busy: "This conversation is still waiting for an answer.",
				runningNative: "Waiting for answer",
				runningBadge: "Waiting",
				pendingNative: "Waiting for the agent…",
				pendingText: "Waiting for the agent…",
				stop: "Stop waiting",
				listLabel: "Threads",
			},
			onClose: () => this.#closeDialog(),
			onCopy: record => {
				const answer = getBtwCopyText(record);
				if (answer !== undefined) void this.#copy(record.id, answer);
			},
			onCancel: record => this.#stopWaiting(record.id),
			canFollowUp: record => {
				const conversation = this.#conversationOf(record.id);
				return conversation !== undefined && !conversation.sending && getBtwLatestTurn(record).status !== "running";
			},
			onFollowUp: (record, question) => {
				const conversation = this.#conversationOf(record.id);
				return conversation ? this.#send(conversation.peer, question, conversation) : Promise.resolve(false);
			},
			onStart: question => this.#send(peer, question),
		});
		this.#dialog = { peerId: peer.instanceId, panel, overlay };
		const newest = records[0];
		if (newest) panel.showRecord(newest.id);
		else panel.openStart();
		this.ctx.ui.requestRender();
		return true;
	}

	/** The picked peer's instance id; labels are disambiguated and mapped back by position. */
	async #pickPeer(runtime: MeshRuntime): Promise<string | undefined> {
		const views = visibleMeshPeers(runtime.engine);
		if (views.length === 0) {
			this.ctx.showStatus("No mesh peers found. Open /mesh to discover or check the key phrase.");
			return undefined;
		}
		const labels = disambiguateDisplayLabels(
			views.map(view => peerTitle(peerOf(view, view.snapshot!))),
			[],
		);
		const choice = await this.ctx.showHookSelector(
			"Ask a mesh agent",
			views.map((view, index) => ({
				label: labels[index]!,
				description: meshDisplayText(
					[view.snapshot?.busy ? "busy" : "idle", view.snapshot?.repo?.branch, view.snapshot?.cwd]
						.filter(Boolean)
						.join(" · "),
				),
			})),
		);
		const index = choice ? labels.indexOf(choice) : -1;
		return index >= 0 ? views[index]!.instanceId : undefined;
	}

	#conversationOf(recordId: string): MeshAskConversation | undefined {
		return this.#conversations.find(entry => entry.record.id === recordId);
	}

	/** Conversations with one peer, newest first, as the panel lists them. */
	#records(instanceId: string): BtwHistoryRecord[] {
		const records: BtwHistoryRecord[] = [];
		for (let index = this.#conversations.length - 1; index >= 0; index--) {
			const conversation = this.#conversations[index]!;
			if (conversation.peer.instanceId === instanceId) records.push(conversation.record);
		}
		return records;
	}

	#refresh(conversation: MeshAskConversation): void {
		const dialog = this.#dialog;
		if (dialog?.peerId === conversation.peer.instanceId) dialog.panel.update(this.#records(dialog.peerId));
	}

	/**
	 * Send one question: a new conversation, or a follow-up in `conversation`'s thread. Resolves
	 * true once the peer acknowledged it (the panel then closes its composer); a refusal keeps the draft.
	 */
	async #send(peer: MeshAskPeer, question: string, conversation?: MeshAskConversation): Promise<boolean> {
		const text = question.trim();
		if (!text || conversation?.sending) return false;
		const runtime = this.#runtime();
		if (!runtime) return false;
		const view = this.#liveView(runtime, peer.instanceId, peerTitle(peer));
		if (!view) return false;
		const outbound = runtime.frontend.outbound;
		let result: MeshSendResult;
		if (conversation) conversation.sending = true;
		try {
			// No abort signal: the peer may already hold the message, and its answer must still route.
			// Always held for a waiter: an answer that overtakes its acknowledgement is kept for it.
			result = await outbound.send({
				to: view,
				fromAgentId: MESH_USER_AGENT_ID,
				kind: "ask",
				text,
				thread: conversation?.thread,
				awaitReply: true,
				// An answer the user no longer waits for: its card is shown; it also completes its turn, if still the latest.
				onLate: reply => {
					if (reply.op !== "reply") return;
					const asked = this.#conversations.find(c => c.msgId === reply.replyTo);
					if (asked) this.#applyReply(asked, reply);
				},
			});
		} catch (error) {
			const message = error instanceof MeshEngineError ? `${error.code}: ${error.message}` : toError(error).message;
			this.ctx.showError(sanitizeErrorLine(`${peerTitle(peer)} unreachable: ${message}`));
			return false;
		} finally {
			if (conversation) conversation.sending = false;
		}
		if (!result.ok) {
			if (conversation && (result.code === "thread_expired" || result.code === "unknown_thread")) {
				// The peer forgot the thread (session switch, TTL): the next message opens a new one.
				conversation.thread = undefined;
				this.ctx.showError(
					sanitizeErrorLine(
						`${peerTitle(peer)} ended this thread (${result.code}). Send again to start a new thread.`,
					),
				);
				return false;
			}
			this.ctx.showError(
				result.code === "blocked"
					? `${peerTitle(peer)} is blocked: ${result.message}`
					: sanitizeErrorLine(`${peerTitle(peer)} refused: ${result.code}: ${result.message}`),
			);
			return false;
		}
		const { record } = beginBtwTurn(text, null, conversation?.record);
		let target = conversation;
		if (target) {
			target.record = record;
			target.msgId = result.msgId;
		} else {
			target = { peer, record, msgId: result.msgId, sending: false };
			this.#conversations.push(target);
		}
		if (result.thread) target.thread = result.thread;
		// Claim the answer in this tick: an `awaitReply: true` entry nobody waits on is never shown.
		void this.#awaitAnswer(target, result.msgId, runtime);
		this.#refresh(target);
		if (!conversation) this.#dialog?.panel.showRecord(target.record.id);
		return true;
	}

	async #awaitAnswer(conversation: MeshAskConversation, msgId: string, runtime: MeshRuntime): Promise<void> {
		const wait = new AbortController();
		conversation.wait = wait;
		const reply = await runtime.frontend.outbound.awaitReply(msgId, MESH_SEND_MAX_TIMEOUT_SEC * 1000, wait.signal);
		if (conversation.wait === wait) conversation.wait = undefined;
		if (conversation.msgId !== msgId) return;
		if (!reply) {
			// Stopped by the user: already marked. Otherwise the wait ran out or the mesh stopped.
			if (wait.signal.aborted) return;
			this.#finishTurn(conversation, {
				status: "error",
				error:
					getMeshRuntime() === runtime
						? `No answer within ${MESH_SEND_MAX_TIMEOUT_SEC / 60} minutes; a later answer appears in the transcript.`
						: "The mesh stopped before the answer arrived.",
			});
			return;
		}
		if (reply.op !== "reply") return;
		this.#applyReply(conversation, reply);
		// A dialog answer has no card: when its dialog is closed, say where it is.
		if (this.#dialog?.peerId !== conversation.peer.instanceId) {
			const title = peerTitle(conversation.peer);
			this.ctx.showStatus(`Answer from ${title} ready · /ask ${conversation.peer.instanceId} to read it`);
		}
	}

	#applyReply(conversation: MeshAskConversation, reply: Extract<MeshIncomingReply, { op: "reply" }>): void {
		if (reply.thread) conversation.thread = reply.thread;
		this.#finishTurn(
			conversation,
			reply.error !== undefined
				? { status: "error", error: reply.error }
				: { status: "complete", answer: reply.text, error: undefined },
		);
	}

	#finishTurn(conversation: MeshAskConversation, patch: Partial<BtwHistoryTurn>): void {
		conversation.record = patchLatestBtwTurn(conversation.record, { ...patch, updatedAt: Date.now() });
		this.#refresh(conversation);
	}

	#stopWaiting(recordId: string): void {
		const conversation = this.#conversationOf(recordId);
		if (!conversation || getBtwLatestTurn(conversation.record).status !== "running") return;
		conversation.wait?.abort();
		this.#finishTurn(conversation, {
			status: "cancelled",
			error: "Stopped waiting; a later answer appears in the transcript.",
		});
	}

	async #copy(recordId: string, answer: string): Promise<void> {
		if (this.#copyInFlight || !answer.trim()) return;
		this.#copyInFlight = true;
		try {
			if (await copyBtwAnswer(this.ctx, answer, "mesh answer")) this.#dialog?.panel.markCopied(recordId, answer);
		} finally {
			this.#copyInFlight = false;
		}
	}

	#closeDialog(): void {
		const dialog = this.#dialog;
		if (!dialog) return;
		this.#dialog = undefined;
		dialog.overlay.hide();
		this.ctx.ui.requestRender();
	}
}
