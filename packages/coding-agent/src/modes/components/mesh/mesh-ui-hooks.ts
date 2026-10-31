/**
 * The interactive TUI's {@link MeshUiHooks}: peer traffic the main agent does not see itself (notes,
 * questions answered by a responder fork, replies to the user's messages) and this instance's replies
 * land in the transcript as `MESH` cards; queued approvals raise a toast pointing at `/mesh`.
 * The card builder strips control sequences and bidi controls from untrusted peer text.
 */
import { createMeshMessageCard } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import type { MeshUiHooks } from "../../../mesh/bridge";
import type { InteractiveModeContext } from "../../types";

export function createTuiMeshUiHooks(
	ctx: Pick<InteractiveModeContext, "present" | "showStatus" | "toolOutputExpanded">,
): MeshUiHooks {
	const getExpanded = () => ctx.toolOutputExpanded;
	return {
		hasUI: true,
		showIncoming(from, entry) {
			ctx.present(
				createMeshMessageCard({ direction: "incoming", peer: from, ...entry, timestamp: Date.now() }, getExpanded),
			);
		},
		showOutgoing(to, entry) {
			ctx.present(
				createMeshMessageCard({ direction: "outgoing", peer: to, ...entry, timestamp: Date.now() }, getExpanded),
			);
		},
		notifyApproval() {
			ctx.showStatus("mesh: approval needed (/mesh)", { toast: true, dim: false });
		},
	};
}
