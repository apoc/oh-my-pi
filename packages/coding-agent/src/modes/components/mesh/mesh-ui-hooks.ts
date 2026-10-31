/**
 * The interactive TUI's {@link MeshUiHooks}: peer notes and replies to the user's messages land
 * in the transcript as notices; queued approvals raise a toast pointing at `/mesh`.
 * Peer text is untrusted: control sequences and bidi controls are stripped before anything renders.
 */
import { noticeRow, TranscriptNotice } from "@oh-my-pi/pi-tui/chrome/transcript-notice";
import { Spacer } from "@oh-my-pi/pi-tui/components/spacer";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { span } from "@oh-my-pi/pi-tui/native/describe";
import { meshDisplayBlock, meshDisplayText, meshSenderLabel } from "@oh-my-pi/pi-tui/overlays/mesh-manager";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { MeshUiHooks } from "../../../mesh/bridge";
import type { MeshSender } from "../../../mesh/wire";
import type { InteractiveModeContext } from "../../types";

function meshNotice(heading: string, body: string): TranscriptNotice {
	const text = meshDisplayBlock(body);
	return new TranscriptNotice(noticeRow("info", [span(heading, "strong"), span(` · ${text}`)]), [
		new Spacer(1),
		new Text(`${heading}\n${text}`, 1, 0).setStyleFn(() => `${theme.bold(theme.fg("accent", heading))}\n${text}`),
	]);
}

function senderLabel(from: MeshSender): string {
	const name = meshDisplayText(from.displayName) || meshDisplayText(from.instanceId);
	return meshSenderLabel(name, meshDisplayText(from.host));
}

export function createTuiMeshUiHooks(ctx: Pick<InteractiveModeContext, "present" | "showStatus">): MeshUiHooks {
	return {
		hasUI: true,
		showNote(from, text) {
			ctx.present(meshNotice(`Mesh note from ${senderLabel(from)}`, text));
		},
		showReply(from, text, thread) {
			const threadLabel = thread ? ` (thread ${meshDisplayText(thread)})` : "";
			ctx.present(meshNotice(`Mesh reply from ${senderLabel(from)}${threadLabel}`, text));
		},
		notifyApproval() {
			ctx.showStatus("mesh: approval needed (/mesh)", { toast: true, dim: false });
		},
	};
}
