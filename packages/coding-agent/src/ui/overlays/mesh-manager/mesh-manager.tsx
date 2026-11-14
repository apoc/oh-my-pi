/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `/mesh` manager: a `picker` sheet listing pending inbound approvals and the local and remote
 * mesh peers, with the selected (or opened) peer or approval as its side preview and the human's
 * actions (mode, key phrase, hide/block, approvals, compose) in its action bar. The compose kind is
 * a chip strip; the key phrase and compose text are a field in the preview. The terminal draws it
 * as a full-height page (look `omp.mesh`). Live: runtime changes pull coalesced, ages tick.
 */
import { computed, type JSXNode, onCleanup } from "@oh-my-pi/pi-tui";
import type { TspPickerProps, TspSpan } from "@oh-my-pi/pi-wire";
import type { MeshDoc } from "../../../modes/view-model/overlays/mesh-manager";
import type { MeshManagerRuntime } from "../../../modes/view-model/overlays/mesh-manager-types";
import "../../styles/panels/mesh-manager";
import { type MeshLookTerm, MeshManagerModel, type MeshManagerOptions, type MeshPreview } from "./model";

export interface MeshManagerProps extends MeshManagerOptions {
	readonly runtime: MeshManagerRuntime;
}

const muted = (t: string): TspSpan[] => [{ t, s: "muted" }];

/** A preview document. Peer text is plain `text`, never `md`: a peer must not get clickable links into this terminal. */
function docNodes(doc: MeshDoc): JSXNode[] {
	const facts = doc.facts
		.filter((entry): entry is readonly [string, readonly TspSpan[]] => entry[1] !== undefined)
		.map(([label, value]) => ({ k: muted(label), v: value }));
	return [
		<text key="title" text={doc.title} role="omp.picker.title" />,
		facts.length > 0 && <kv key="facts" items={facts} />,
		...doc.sections.map(section => (
			<section key={section.id} head={muted(section.head)}>
				{typeof section.body === "string" ? (
					<text text={section.body} wrap="word" />
				) : (
					section.body.map((line, index) => <text key={String(index)} spans={line} wrap="word" />)
				)}
			</section>
		)),
	];
}

function previewNodes(preview: MeshPreview): JSXNode[] {
	switch (preview.kind) {
		case "doc":
			return docNodes(preview.doc);
		case "gone":
			return [<text key="gone" spans={[{ t: "This peer is gone.", s: "warning" }]} />];
		case "prompt": {
			const { prompt, notice } = preview;
			return [
				<text key="title" text={prompt.title} role="omp.picker.title" wrap="word" />,
				prompt.hint && <text key="hint" spans={[{ t: prompt.hint, s: "dim" }]} wrap="word" />,
				<col key="field" role="omp.form.field">
					<input prompt="> " sendable={false} text={prompt.text} cursor={prompt.cursor} />
				</col>,
				prompt.warning && <text key="warning" spans={[{ t: prompt.warning, s: "warning" }]} wrap="word" />,
				notice && <text key="notice" spans={[notice]} wrap="word" />,
			];
		}
		case "none":
			return [];
	}
}

export function MeshManager(props: MeshManagerProps): JSXNode {
	const model = new MeshManagerModel(props.runtime, props);
	onCleanup(() => model.dispose());
	const view = computed(() => (model.rev(), model.pickerView()));
	const prop =
		<K extends keyof TspPickerProps>(name: K) =>
		() =>
			view()[name];
	return (
		<picker
			term={(): MeshLookTerm => ({ look: "omp.mesh", model, rev: model.rev() })}
			title="Mesh"
			icon="network"
			noun="peers"
			size="lg"
			layout="rows"
			preview="side"
			query={null}
			subtitle={prop("subtitle")}
			message={prop("message")}
			columns={prop("columns")}
			items={prop("items")}
			order={prop("order")}
			selected={prop("selected")}
			empty={prop("empty")}
			strip={prop("strip")}
			actions={prop("actions")}
			focus={prop("focus")}
			onKey={key => model.key(key)}
			onPaste={paste => model.paste(paste.text)}
			onEvent={event => model.event(event)}
		>
			{() => (model.rev(), previewNodes(model.preview()))}
		</picker>
	);
}
