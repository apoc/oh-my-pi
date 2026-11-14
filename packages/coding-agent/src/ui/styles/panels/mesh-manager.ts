/**
 * `omp.mesh`: the `/mesh` manager picker in the terminal, drawn as a framed full-height page: the
 * status header, the list (or a peer's details, scrolled), the open prompt with its field, the
 * notice and the key hints. The page comes from the manager model in the picker's `term` facts
 * ({@link MeshLookTerm}), built only when the terminal draws it; this look fits it to the screen.
 */
import { type Block, EMPTY_BLOCK, type Hit } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import {
	boxBottom,
	boxRow,
	boxRule,
	boxTop,
	definePickerLook,
	pickerState,
	pickerTerm,
	sheetHit,
} from "@oh-my-pi/pi-tui/term/painters/picker";
import { spaces, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import { fitMeshHints, type MeshRow } from "../../../modes/view-model/overlays/mesh-manager";
import type { MeshLookTerm } from "../../overlays/mesh-manager/model";
import { caretField } from "../pickers/common";

/** The page never shrinks below this many rows. */
const MIN_ROWS = 8;
/** Rows the key hints may take. */
const HINT_ROWS = 2;

definePickerLook("omp.mesh", (node, cx): Block => {
	const width = cx.width;
	if (width < 8) return EMPTY_BLOCK;
	const theme = cx.theme;
	const term = (pickerTerm(node) as unknown as MeshLookTerm).model.page();
	const inner = width - 4;
	const ellipsis = theme.symbols.ellipsis;
	const draw = (row: MeshRow): string[] => {
		if (row.field) return [caretField(theme, "> ", row.field.text, row.field.cursor, inner)];
		const text = styledText(theme, row.spans);
		if (row.wrap === undefined) return [truncate(text, inner, ellipsis)];
		const indent = row.indent ?? 0;
		const room = Math.max(1, inner - indent);
		const lines = wrap(text, room);
		const shown = lines.slice(0, row.wrap);
		if (lines.length > shown.length) shown[shown.length - 1] = `${truncate(shown.at(-1)!, room - 1, "")}${ellipsis}`;
		return shown.map(line => `${spaces(indent)}${line}`);
	};

	const header = term.header.flatMap(draw);
	const bottom = [
		...term.bottom.flatMap(draw),
		...fitMeshHints(term.hints, inner, HINT_ROWS).map(hint => theme.style("dim", hint)),
	];
	const body: string[] = [];
	const items: (string | undefined)[] = [];
	let selStart = 0;
	let selEnd = 0;
	term.body.forEach((row, index) => {
		if (index === term.selection?.start) selStart = body.length;
		for (const line of draw(row)) {
			body.push(line);
			items.push(row.item);
		}
		if (index === (term.selection?.end ?? 0) - 1) selEnd = body.length;
	});

	// Borders: top, two rules, bottom.
	const bodyHeight =
		cx.height === undefined
			? body.length
			: Math.max(1, Math.max(MIN_ROWS, cx.height) - header.length - bottom.length - 4);
	const last = Math.max(0, body.length - bodyHeight);
	let start = 0;
	if (term.scroll) {
		start = Math.max(0, Math.min(term.scroll.offset, last));
		if (start !== term.scroll.offset) term.scroll.clamp(start);
	} else if (term.selection) {
		// Keep the selected item's rows on screen, moving the window only as far as needed.
		const state = pickerState(node, "mesh.scroll", () => 0);
		let next = state.peek();
		if (selEnd - next > bodyHeight) next = selEnd - bodyHeight;
		if (selStart < next) next = selStart;
		next = Math.max(0, Math.min(next, last));
		if (next !== state.peek()) state.set(next);
		start = next;
	}

	const rows = [boxTop(theme, width, "Mesh")];
	for (const line of header) rows.push(boxRow(theme, width, line));
	rows.push(boxRule(theme, width));
	const hits: Hit[] = [];
	for (let i = 0; i < bodyHeight; i++) {
		const item = items[start + i];
		if (item) hits.push({ row: rows.length, col: 2, width: inner, height: 1, node, item });
		rows.push(boxRow(theme, width, body[start + i] ?? ""));
	}
	rows.push(boxRule(theme, width));
	for (const line of bottom) rows.push(boxRow(theme, width, line));
	rows.push(boxBottom(theme, width));
	return { rows, hits: [sheetHit(node, width, rows.length), ...hits] };
});
