/**
 * Peer-supplied text on its way into the agent's context. Bidi controls are removed first so a peer
 * cannot reorder what the user or model reads (e.g. RLO in a session name), nor hide a harness tag
 * from the escape. Default-ignorable and format characters (zero-width space, joiners, variation selectors, …)
 * and non-whitespace controls are dropped from tag-like runs for the same reason; then harness tags are escaped
 * so it cannot forge or close harness blocks.
 */
import { stripBidiControls } from "@oh-my-pi/pi-utils";
import { escapeHarnessTags } from "../session/harness-tags";

/** A `<`, optional whitespace/slash/invisibles/controls, then a tag-name-like run of letters, digits, `_`, `-` and invisibles/controls: where an invisible character could split a tag name. Prose after a `<` and a space-separated word is left alone. Invisibles are default-ignorable and format characters. */
const TAG_RUN_RE = /<[\s/\p{DI}\p{Cf}\p{Cc}]*[\p{L}\p{N}\p{DI}\p{Cf}\p{Cc}_-]*/gu;
/** Default-ignorable and format characters, and non-whitespace controls, removed from tag-like runs; line breaks and tabs stay. */
const HIDDEN_CHAR_RE = /[\p{DI}\p{Cf}]|(?!\s)\p{Cc}/gu;

/** C0/C1 controls (newlines included), line/paragraph separators and backticks. */
const PEER_FIELD_BREAK_RE = /[\p{Cc}\p{Zl}\p{Zp}`]/gu;

/** Peer text safe to render into a model-facing message or result. */
export function meshPeerText(text: string): string {
	const visible = stripBidiControls(text).replace(TAG_RUN_RE, run => run.replace(HIDDEN_CHAR_RE, ""));
	return escapeHarnessTags(visible);
}

/**
 * A peer-controlled single-line value (display name, host, ids, session, cwd, branch, …), often
 * rendered inside backticks: every line break, control character and backtick becomes a space
 * before {@link meshPeerText} runs, so the value can neither leave its code span, start a new
 * harness-looking line, nor hide a harness tag behind a control character.
 */
export function meshPeerField(text: string): string {
	return meshPeerText(text.replace(PEER_FIELD_BREAK_RE, " "));
}

/** {@link meshPeerField} for a slot inside a JSON string literal of a prompt: `"` and `\` are dropped. */
export function meshPeerJsonField(text: string): string {
	return meshPeerField(text).replace(/["\\]/g, "");
}
