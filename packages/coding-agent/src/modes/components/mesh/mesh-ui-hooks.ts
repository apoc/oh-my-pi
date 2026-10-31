/**
 * The interactive TUI's {@link MeshUiHooks}: peer traffic the main agent does not see itself (notes,
 * questions answered by a responder fork, replies to the user's messages) and this instance's replies
 * land in the transcript as `MESH` cards; queued approvals raise a toast pointing at `/mesh`.
 * The card builder strips control sequences and bidi controls from untrusted peer text.
 */
import { createMeshMessageCard, type MeshMessageCard } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import type { MeshUiHooks } from "../../../mesh/bridge";
import type { InteractiveModeContext } from "../../types";

/** Present one `MESH ←/→ peer` transcript card. */
export function presentMeshCard(
	ctx: Pick<InteractiveModeContext, "present" | "toolOutputExpanded">,
	card: Omit<MeshMessageCard, "timestamp">,
): void {
	ctx.present(createMeshMessageCard({ ...card, timestamp: Date.now() }, () => ctx.toolOutputExpanded));
}

export function createTuiMeshUiHooks(
	ctx: Pick<InteractiveModeContext, "present" | "showStatus" | "toolOutputExpanded" | "handleMeshAskReply">,
): MeshUiHooks {
	return {
		hasUI: true,
		showIncoming(from, entry) {
			presentMeshCard(ctx, { direction: "incoming", peer: from, ...entry });
			// Answers to the user's `/ask` questions also complete their conversation.
			if (entry.kind === "reply") ctx.handleMeshAskReply(from, entry);
		},
		showOutgoing(to, entry) {
			presentMeshCard(ctx, { direction: "outgoing", peer: to, ...entry });
		},
		notifyApproval() {
			ctx.showStatus("mesh: approval needed (/mesh)", { toast: true, dim: false });
		},
	};
}
