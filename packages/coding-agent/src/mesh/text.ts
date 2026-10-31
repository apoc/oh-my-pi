/**
 * Peer-supplied text on its way into the agent's context. Bidi controls are removed first so a peer
 * cannot reorder what the user or model reads (e.g. RLO in a session name), nor hide a harness tag
 * from the escape; then harness tags are escaped so it cannot forge or close harness blocks.
 */
import { stripBidiControls } from "@oh-my-pi/pi-utils";
import { escapeHarnessTags } from "../session/harness-tags";

/** Peer text safe to render into a model-facing message or result. */
export function meshPeerText(text: string): string {
	return escapeHarnessTags(stripBidiControls(text));
}
