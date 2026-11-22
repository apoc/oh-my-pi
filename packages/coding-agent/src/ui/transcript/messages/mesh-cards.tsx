/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Mesh traffic in the transcript: `MESH ⟵ peer` (incoming) and `MESH ➤ peer`
 * (outgoing) cards in the IRC card style (`omp.mesh.<direction>`), tagged with
 * the message kind, its thread and an error flag. A persisted `mesh:incoming`
 * custom message (a peer's steer) renders through `MeshIncomingMessage`; live
 * traffic the main agent never sees is presented with `MeshCard`.
 *
 * Peer text is untrusted: control sequences and bidi controls are stripped
 * (`meshDisplayText` / `meshDisplayBlock`) before anything renders.
 */
import { type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { meshDisplayBlock, meshDisplayText, meshSenderLabel } from "../../../modes/view-model/overlays/mesh-display";
import { type IrcMessage, IrcMessageCard } from "../../tools/irc";

/** One unit of mesh traffic between this instance and a peer, as the human sees it. */
export interface MeshMessageCard {
	readonly direction: "incoming" | "outgoing";
	/** The remote end; peer-declared, sanitized here. */
	readonly peer: { displayName?: string; instanceId?: string; host?: string } | undefined;
	/** Message kind (`ask`, `steer`, `note`, …), `reply`, or a watch event. */
	readonly kind: string;
	readonly text: string;
	readonly thread?: string;
	readonly error?: boolean;
	readonly timestamp?: number;
}

/** The IRC-style card of one mesh message. */
function meshMessage(card: MeshMessageCard): IrcMessage {
	const name = meshDisplayText(card.peer?.displayName) || meshDisplayText(card.peer?.instanceId) || "?";
	const peer = meshSenderLabel(name, meshDisplayText(card.peer?.host)).trim() || "?";
	const tags = [meshDisplayText(card.kind)];
	if (card.thread) tags.push(`thread ${meshDisplayText(card.thread)}`);
	if (card.error) tags.push("error");
	const glyph = card.direction === "incoming" ? "nav.back" : "nav.selected";
	return {
		kind: "relay",
		title: theme => `MESH ${theme.symbols.symbol(glyph)} ${peer}`,
		role: `omp.mesh.${card.direction}`,
		body: meshDisplayBlock(card.text),
		plain: true,
		timestamp: card.timestamp,
		tags,
	};
}

/** One mesh message as a card. `expanded` is the transcript's expand state. */
export function MeshCard(props: { readonly card: MeshMessageCard; readonly expanded: () => boolean }): JSXNode {
	return <IrcMessageCard message={meshMessage(props.card)} expanded={props.expanded} />;
}

/** `details` of a persisted `mesh:incoming` custom message. */
interface MeshIncomingDetails {
	readonly kind?: string;
	readonly from?: { displayName?: string; instanceId?: string; host?: string };
	readonly message?: string;
}

/** A persisted `mesh:incoming` custom message (a peer's steer) as an incoming mesh card. */
export function MeshIncomingMessage(props: {
	readonly message: { readonly details?: unknown; readonly timestamp: number };
	readonly expanded: Reactive<boolean>;
}): JSXNode {
	const details = props.message.details as MeshIncomingDetails | undefined;
	return (
		<MeshCard
			card={{
				direction: "incoming",
				peer: details?.from,
				kind: details?.kind ?? "steer",
				text: details?.message ?? "",
				timestamp: props.message.timestamp,
			}}
			expanded={() => read(props.expanded)}
		/>
	);
}
