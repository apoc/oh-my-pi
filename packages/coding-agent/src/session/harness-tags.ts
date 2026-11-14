/**
 * `<` of a harness tag: `irc`, `tangent-notice`, a hyphenated `mesh-*` envelope
 * (`mesh-message`, `mesh-reply`, …; plain `<mesh>` is react-three-fiber JSX and stays
 * untouched) or a `system-*` name (`system-notice`, `system-reminder`,
 * `system-interrupt`, …), opening or closing. The system prompt tells the model these
 * blocks are harness-authored, so untrusted text inside them must neither close them
 * nor forge new ones.
 */
const HARNESS_TAG_START_RE = /<(?=\s*\/?\s*(?:irc|tangent-notice|mesh-[a-z][a-z-]*|system-[a-z][a-z-]*)(?![\w-]))/gi;

/**
 * Keep agent- or job-authored text from closing the harness block it is
 * rendered into, or opening a forged one such as a parent's `<irc from="parent">`.
 * Only harness tag names are escaped, so code, placeholders and the harness's
 * own nested `<task-result>` envelope reach the model unchanged.
 */
export function escapeHarnessTags(text: string): string {
	return text.replace(HARNESS_TAG_START_RE, "&lt;");
}
