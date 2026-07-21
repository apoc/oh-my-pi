import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Container } from "@oh-my-pi/pi-tui";
import type { AssistantMessageComponent } from "../components/assistant-message";

/**
 * Renders an assistant message as a sequence of `AssistantMessageComponent` segments
 * interleaved with tool components in `chatContainer`. Each tool-call block closes the
 * open segment and starts a new one positioned AFTER the tool, so chatContainer siblings
 * appear in the order the model emitted them.
 *
 * Lifecycle: `startMessage` opens segment 0 and attaches it immediately. Each subsequent
 * `splitAt(idx)` closes the trailing segment at `idx` and stages a fresh segment that is
 * NOT yet in `chatContainer` — the caller is expected to add the tool component to
 * `chatContainer` next, then call {@link attachOpenSegment} so the order is
 * `[..., closed, tool, open]`. If a caller skips `attachOpenSegment`, the next `splitAt`
 * or `finalize` auto-flushes the staged segment so it can never be orphaned.
 */
export class SegmentedMessageBuilder {
	#segments: AssistantMessageComponent[] = [];
	#openStartIndex = 0;
	#segmentedToolCallIds = new Set<string>();
	#pendingAttach: AssistantMessageComponent | undefined;

	constructor(
		private readonly chatContainer: Container,
		private readonly createSegment: (options: {
			startIndex: number;
			isFinalSegment: boolean;
		}) => AssistantMessageComponent,
	) {}

	/**
	 * Open the first segment for a new assistant message, attach it immediately, and render.
	 */
	startMessage(message: AssistantMessage): AssistantMessageComponent {
		const first = this.createSegment({ startIndex: 0, isFinalSegment: false });
		this.#segments.push(first);
		this.chatContainer.addChild(first);
		first.updateContent(message);
		return first;
	}

	/**
	 * Close the trailing segment at `boundaryIndex` and stage a fresh segment starting at the
	 * same index. Callers MUST have invoked {@link startMessage} first. The staged segment is
	 * not yet in `chatContainer` — call {@link attachOpenSegment} after the tool component is
	 * inserted so chatContainer order stays `[..., closed, tool, open]`.
	 */
	splitAt(boundaryIndex: number): { closed: AssistantMessageComponent; opened: AssistantMessageComponent } {
		// Self-defense: if a previous splitAt was never paired with attachOpenSegment,
		// flush it now so the stale segment lands in the container before the new one.
		this.#flushPendingAttach();
		const closed = this.getOpenSegment();
		if (!closed) {
			throw new Error("SegmentedMessageBuilder.splitAt called before startMessage");
		}
		closed.setContentRange(this.#openStartIndex, boundaryIndex);
		const opened = this.createSegment({ startIndex: boundaryIndex, isFinalSegment: false });
		this.#segments.push(opened);
		this.#openStartIndex = boundaryIndex;
		this.#pendingAttach = opened;
		return { closed, opened };
	}

	/**
	 * Attach the segment most recently produced by {@link splitAt} to `chatContainer`. The
	 * segment is NOT rendered here — callers run their own per-delta or end-of-message render
	 * pass ({@link updateOpenContent} / {@link finalize} / {@link updateClosedContent}), so
	 * rendering at attach time would be a redundant pre-paint on the same tick.
	 */
	attachOpenSegment(): void {
		this.#flushPendingAttach();
	}

	#flushPendingAttach(): void {
		if (!this.#pendingAttach) return;
		this.chatContainer.addChild(this.#pendingAttach);
		this.#pendingAttach = undefined;
	}

	/**
	 * Mark a tool-call id as already used to open a segment. Returns true if this is the
	 * first time the id is seen (caller should open a new segment), false otherwise.
	 */
	markToolSegmented(toolCallId: string): boolean {
		if (this.#segmentedToolCallIds.has(toolCallId)) return false;
		this.#segmentedToolCallIds.add(toolCallId);
		return true;
	}

	getOpenSegment(): AssistantMessageComponent | undefined {
		return this.#segments[this.#segments.length - 1];
	}

	/** The first segment of the message, which owns the top-of-turn cache-invalidation
	 *  marker (see {@link AssistantMessageComponent.setCacheInvalidation}) regardless of
	 *  how many later segments a tool-call split produced. */
	getFirstSegment(): AssistantMessageComponent | undefined {
		return this.#segments[0];
	}

	getOpenStartIndex(): number {
		return this.#openStartIndex;
	}

	/** Freeze every closed (non-trailing) segment so the transcript's commit-safe run
	 * can extend through them into the streaming tool preview below. The trailing open
	 * segment stays live — it may still receive post-tool text. */
	markClosedTranscriptBlocksFinalized(): void {
		const trailing = this.getOpenSegment();
		for (const segment of this.#segments) {
			if (segment !== trailing) segment.markTranscriptBlockFinalized();
		}
	}

	/** Re-render every segment except the trailing one. Used at message_end (after
	 * {@link finalize} already rendered the trailing) and at the end of the rebuild pass
	 * (intermediate segments are attached without rendering, so they get their first paint
	 * here). The trailing is skipped to avoid double-rendering it. */
	updateClosedContent(message: AssistantMessage): void {
		const trailing = this.getOpenSegment();
		for (const segment of this.#segments) {
			if (segment !== trailing) segment.updateContent(message);
		}
	}

	/** Re-render only the open (trailing) segment. Used per stream delta — closed segments
	 * have a fixed slice and their content doesn't grow once a tool-call boundary closes
	 * them (cursor's wire protocol seals text/thinking blocks before tool deltas), so
	 * re-rendering them per delta is wasted work. */
	updateOpenContent(message: AssistantMessage): void {
		const open = this.getOpenSegment();
		if (open) open.updateContent(message);
	}

	/** Mark the trailing segment as final (so it owns usage/error footer) and let its
	 * endIndex flow to the end of `message.content`. Returns the finalized segment. */
	finalize(message: AssistantMessage): AssistantMessageComponent | undefined {
		this.#flushPendingAttach();
		const trailing = this.getOpenSegment();
		if (!trailing) return undefined;
		trailing.applyFinalSegmentRange(this.#openStartIndex, message);
		// The message is complete: freeze every segment (not just the trailing one) so the
		// transcript container can drop them from the repaintable live region and commit
		// scrolled-off rows to native scrollback. Covers the streaming message_end path and
		// the session-rebuild path, which both route through finalize().
		for (const segment of this.#segments) {
			segment.markTranscriptBlockFinalized();
		}
		return trailing;
	}

	/** Remove the trailing open segment from `chatContainer` (used when a run ends without
	 * a `message_end` — earlier segments already hold finalized content). */
	discardOpenSegment(): AssistantMessageComponent | undefined {
		const open = this.getOpenSegment();
		if (!open) return undefined;
		// If the trailing segment was staged but never attached, dropping pendingAttach is
		// enough — chatContainer never saw it. If it was already attached, remove it.
		if (this.#pendingAttach === open) {
			this.#pendingAttach = undefined;
		} else {
			this.chatContainer.removeChild(open);
		}
		this.#segments.pop();
		// The run ended (abort/error without message_end): the earlier segments are now
		// frozen, so finalize them to release the transcript live region.
		for (const segment of this.#segments) {
			segment.markTranscriptBlockFinalized();
		}
		return open;
	}
}
