/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/btw` history: the session's side questions (newest first) beside the
 * selected one's thread — each turn's question, when it was asked, its answer
 * (an `<inject>` block apart while it can be sent) — and the follow-up
 * composer under the newest answer; the footer holds what the answer allows
 * (Stop, Inject, Branch, Copy), Close and Follow up (Cancel/Send while
 * composing). With one side question the reader stands alone.
 *
 * The terminal draws its own boxed sheet from the same model
 * (`styles/panels/btw-history-panel.ts`).
 */
import { type JSXNode, untrack } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { sanitizeDisplayLine, sanitizeDisplayText } from "../../../extensibility/inventory/display-text";
import { sanitizeErrorLine } from "../../../modes/view-model/chrome/error-block";
import type { BtwHistoryRecord, BtwHistoryTurn } from "../../../session/btw-history-model";
import { getBtwLatestTurn } from "../../../session/btw-history-model";
import "../../styles/panels/btw-history-panel";
import { BtwInjectAnswer } from "./btw-answer";
import {
	BTW_HISTORY_TEXTS,
	type BtwHistoryModel,
	type BtwHistoryTexts,
	DATE_FORMAT,
	displayTurns,
	type FollowUpComposer,
	type InjectBlock,
	listStamp,
	sameLocalDay,
	TIME_FORMAT,
	topicLabel,
} from "./btw-history-panel-model";
import { ActionButton, applyEdit } from "./common";
import { actionKeyId, kbdOf } from "../../keys/hints";
import { keyTitle } from "../../styles/panels/common";
import { rowsRole, type SheetAttributes } from "../sheet";

/** Tern's sheet: a large centered one (the list beside the reader), palette-sized while there is nothing to list. */
export function btwHistorySheet(model: BtwHistoryModel): SheetAttributes {
	return {
		role: model.texts.role,
		anchor: "center",
		size: () => (model.rev(), model.records.length > 0 ? "lg" : "md"),
		head: sanitizeDisplayLine(model.texts.heading),
		modal: true,
	};
}

/** A status worth naming beside an answer natively; an answered question needs none. */
export function btwStatusSpans(
	status: BtwHistoryTurn["status"],
	running = BTW_HISTORY_TEXTS.runningNative,
): TspSpan[] | undefined {
	switch (status) {
		case "running":
			return [
				{ s: "accent", t: "●", fx: "pulse" },
				{ s: "accent", t: ` ${running}` },
			];
		case "cancelled":
			return [{ s: "warning", t: "Cancelled" }];
		case "error":
			return [{ s: "error", t: "Failed" }];
		case "interrupted":
			return [{ s: "warning", t: "Interrupted" }];
		case "complete":
			return undefined;
	}
}

function Button(props: {
	readonly label: string;
	readonly act: string;
	readonly shortcut?: string;
	readonly accent?: boolean;
}) {
	const keys = props.shortcut === undefined ? undefined : kbdOf(props.shortcut);
	return (
		<ActionButton
			id={props.act}
			label={props.label}
			title={props.shortcut ? `${props.label}  ${keyTitle(props.shortcut)}` : props.label}
			keys={keys}
			tone={props.accent ? "accent" : undefined}
		/>
	);
}

function HistoryList(props: { readonly model: BtwHistoryModel }): JSXNode {
	const { model } = props;
	const now = model.now();
	return (
		<col key="history" role="omp.btw.history" shrink={0}>
			<list
				key="records"
				role={model.focus === "list" ? "omp.btw.list" : "omp.btw.list.idle"}
				selected={model.selectedId ?? null}
			>
				{model.records.map(record => {
					const followUps = record.followUps?.length ?? 0;
					const detail: TspSpan[] = [{ s: "mono", t: listStamp(record.createdAt, now) }];
					if (followUps > 0) detail.push({ t: ` · ${followUps} follow-up${followUps === 1 ? "" : "s"}` });
					// The topic is markdown: its `code` reads as mono, without the backticks.
					const label = sanitizeDisplayLine(topicLabel(record))
						.split(/`([^`]+)`/)
						.flatMap((part, index): TspSpan[] =>
							part ? [index % 2 === 1 ? { s: "mono", t: part } : { t: part }] : [],
						);
					return (
						<item
							key={record.id}
							label={label}
							detail={detail}
							value={btwStatusSpans(getBtwLatestTurn(record).status, model.texts.runningNative)}
						/>
					);
				})}
			</list>
		</col>
	);
}

function Turn(props: {
	readonly turn: BtwHistoryTurn;
	readonly index: number;
	readonly block: InjectBlock | undefined;
	readonly topicCreatedAt: number;
	readonly texts: BtwHistoryTexts;
}): JSXNode {
	const { turn, index, block, texts } = props;
	// A follow-up asked on the topic's day needs only its time.
	const meta: TspSpan[] =
		index === 0
			? [{ t: DATE_FORMAT.format(turn.createdAt) }]
			: [
					{ t: "Follow-up · " },
					{
						t: (sameLocalDay(turn.createdAt, props.topicCreatedAt) ? TIME_FORMAT : DATE_FORMAT).format(
							turn.createdAt,
						),
					},
				];
	const status = btwStatusSpans(turn.status, texts.runningNative);
	if (status) meta.push({ t: "  ·  " }, ...status);
	const stream = turn.status === "running";
	let answer: JSXNode = null;
	// A failed turn with no text says only why it failed.
	if (turn.answer.trim() || !turn.error) {
		answer = block ? (
			<BtwInjectAnswer parts={block.parts} state={block.state} stream={stream} />
		) : turn.answer.trim() ? (
			<md text={sanitizeDisplayText(turn.answer)} stream={stream} />
		) : (
			<text role="omp.btw.pending" spans={[{ s: "dim", t: stream ? texts.pendingNative : "No answer text." }]} />
		);
	}
	return (
		<col key={`turn-${index}`} role="omp.btw.turn">
			<md text={sanitizeDisplayText(turn.question)} role={index === 0 ? "omp.btw.question" : "omp.btw.followup"} />
			<text role="omp.btw.meta" spans={meta} truncate="end" lines={1} />
			{answer && (
				<col key="answer" role="omp.btw.answer">
					{answer}
				</col>
			)}
			{turn.error && (
				<text role="omp.btw.error" spans={[{ s: "error", t: sanitizeErrorLine(turn.error) }]} wrap="word" />
			)}
			{turn.status === "interrupted" && (
				<text role="omp.btw.note" spans={[{ s: "muted", t: "Not resumed in this view." }]} />
			)}
		</col>
	);
}

/** The follow-up composer under the thread, or a new topic's in its place. */
function Composer(props: { readonly model: BtwHistoryModel; readonly composer: FollowUpComposer }): JSXNode {
	const { model, composer } = props;
	const followUp = composer.recordId !== undefined;
	return (
		<col key="composer" role="omp.btw.composer" gap="sm">
			<input
				text={composer.draft.text}
				cursor={composer.draft.cursor}
				placeholder={followUp ? model.texts.followUpPlaceholder : model.texts.startPlaceholder}
				prompt={followUp ? "Follow up: " : "Ask: "}
				sendable={false}
				onEdit={event => {
					const next = applyEdit(composer.draft, event);
					if (next) model.setDraft(next);
				}}
			/>
			{composer.notice && (
				<text
					role="omp.btw.notice"
					spans={[{ s: model.followUpPending ? "dim" : "warning", t: composer.notice }]}
					wrap="word"
				/>
			)}
		</col>
	);
}

function Thread(props: { readonly model: BtwHistoryModel; readonly record: BtwHistoryRecord }): JSXNode {
	const { model, record } = props;
	return (
		<col key="thread" role="omp.btw.thread">
			{displayTurns(record).map((turn, index) => (
				<Turn
					turn={turn}
					index={index}
					block={model.injectBlock(record, turn, index)}
					topicCreatedAt={record.createdAt}
					texts={model.texts}
				/>
			))}
			{model.composer?.recordId !== undefined && <Composer model={model} composer={model.composer} />}
		</col>
	);
}

function Actions(props: { readonly model: BtwHistoryModel; readonly record: BtwHistoryRecord | undefined }) {
	const { model, record } = props;
	const cancelKey = actionKeyId("tui.select.cancel", "escape");
	if (model.composer) {
		return (
			<row key="actions" role="omp.actions" align="center" gap="sm">
				<spacer grow={1} />
				<Button label="Cancel" act="discard" shortcut={cancelKey} />
				<Button
					label={model.followUpPending ? "Sending…" : "Send"}
					act="send"
					shortcut={actionKeyId("tui.input.submit", "enter")}
					accent
				/>
			</row>
		);
	}
	const running = model.running(record);
	const hides = model.options.escapeHides === true;
	const copied = record !== undefined && model.isCopied(record);
	const startable = model.options.onStart !== undefined;
	return (
		<row key="actions" role="omp.actions" align="center" gap="sm">
			{running && <Button label={model.texts.stop} act="stop" shortcut={hides ? "x" : cancelKey} />}
			{model.canInject(record) && <Button label="Inject into main" act="inject" shortcut={model.injectKey} />}
			{model.canBranch(record) && <Button label="Branch to chat" act="branch" shortcut="b" />}
			{model.canCopy(record) && [
				<Button label={copied ? "Copy again" : "Copy answer"} act="copy-answer" shortcut="c" />,
				copied && <text role="omp.btw.copied" spans={[{ s: "success", t: "✓ Copied" }]} />,
			]}
			{/* A new topic sits with the answer's actions, or in the corner while there is nothing else to do. */}
			{startable && record && <Button label="New question" act="start" shortcut="n" />}
			<spacer grow={1} />
			{/* Clicking Close always dismisses; its tooltip names Esc only where Esc does too. */}
			<Button label="Close" act="close" shortcut={running && !hides ? undefined : cancelKey} />
			{model.canFollowUp(record) && <Button label="Follow up" act="follow-up" shortcut="f" accent />}
			{startable && !record && <Button label="New question" act="start" shortcut="n" accent />}
		</row>
	);
}

export function BtwHistoryPanel(props: { readonly model: BtwHistoryModel }): JSXNode {
	const { model } = props;
	return () => {
		model.rev();
		return untrack(() => {
			const record = model.selected();
			// A new topic's composer belongs to no record yet: it takes the reader's place.
			const starting = model.composer?.recordId === undefined ? model.composer : undefined;
			return (
				<col
					gap="none"
					role={rowsRole("omp.btw.sheet")}
					// The mic glyph moves alone (every animation frame), without rebuilding the sheet.
					term={() => ({ model, rev: untrack(model.rev), caretGlyph: model.caretGlyph() })}
					onKey={key => model.key(key)}
					onPaste={paste => {
						if (!model.composer) return false;
						model.paste(paste.text);
						return true;
					}}
					onAction={act => model.action(act)}
					onSelect={item => model.pick(item, false)}
					onActivate={item => model.pick(item, true)}
				>
					{record ? (
						<row key="body" role="omp.btw.body">
							{model.records.length > 1 && <HistoryList model={model} />}
							<col
								key="details"
								role="omp.btw.reader"
								grow={1}
								basis={0}
								min={{ w: 0 }}
								scroll={model.nativeScroll}
							>
								{starting ? (
									<Composer model={model} composer={starting} />
								) : (
									<Thread model={model} record={record} />
								)}
							</col>
						</row>
					) : (
						[
							<col key="empty" role="omp.btw.empty" align="center" gap="sm">
								<text role="omp.btw.empty.title" text={sanitizeDisplayLine(model.texts.emptyTitle)} />
								<text
									role="omp.btw.empty.hint"
									spans={
										// The default names `/btw <question>` as code; a host's hint is plain text.
										model.options.texts?.emptyHint === undefined
											? [
													{ t: "Ask one with " },
													{ s: "code", t: "/btw <question>" },
													{ t: ". The answer stays out of the main conversation." },
												]
											: [{ t: sanitizeDisplayLine(model.texts.emptyHint) }]
									}
									wrap="word"
								/>
							</col>,
							starting && <Composer model={model} composer={starting} />,
						]
					)}
					<Actions model={model} record={record} />
				</col>
			);
		});
	};
}
