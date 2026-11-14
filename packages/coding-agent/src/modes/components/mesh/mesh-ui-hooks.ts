/**
 * The interactive TUI's {@link MeshUiHooks}: peer traffic the main agent does not see itself (notes,
 * questions answered by a responder fork, replies to the user's messages) and this instance's replies
 * land in the transcript as `MESH` cards; queued approvals raise a toast pointing at `/mesh`.
 * The card builder strips control sequences and bidi controls from untrusted peer text.
 */
import type { MeshUiHooks } from "../../../mesh/bridge";
import { MeshCard, type MeshMessageCard } from "../../../ui/transcript/messages/mesh-cards";
import type { InteractiveModeContext } from "../../types";

/** Present one `MESH ←/→ peer` transcript card. */
export function presentMeshCard(
	ctx: Pick<InteractiveModeContext, "present" | "toolOutputExpanded">,
	card: Omit<MeshMessageCard, "timestamp">,
): void {
	const timestamp = Date.now();
	ctx.present(() => MeshCard({ card: { ...card, timestamp }, expanded: () => ctx.toolOutputExpanded }));
}

export function createTuiMeshUiHooks(
	ctx: Pick<InteractiveModeContext, "present" | "showStatus" | "toolOutputExpanded">,
): MeshUiHooks {
	return {
		hasUI: true,
		showIncoming(from, entry) {
			presentMeshCard(ctx, { direction: "incoming", peer: from, ...entry });
		},
		showOutgoing(to, entry) {
			presentMeshCard(ctx, { direction: "outgoing", peer: to, ...entry });
		},
		notifyApproval() {
			ctx.showStatus("mesh: approval needed (/mesh)", { toast: true, dim: false });
		},
	};
}
