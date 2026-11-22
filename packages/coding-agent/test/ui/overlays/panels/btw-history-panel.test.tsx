/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createRoot, resolveChildren, setNativeRenderingForTest, type UiNode } from "@oh-my-pi/pi-tui";
import { decodeMouse } from "@oh-my-pi/pi-tui/driver/input/mouse";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import type { BtwHistoryRecord } from "../../../../src/session/btw-history-model";
import { BtwHistoryPanel, btwHistorySheet } from "../../../../src/ui/overlays/panels/btw-history-panel";
import { type BtwHistoryOptions, BtwHistoryModel } from "../../../../src/ui/overlays/panels/btw-history-panel-model";
import { printRows } from "../../../../src/ui/print-rows";
import { keyEvent } from "../../../helpers/input-harness";
import { type Driver, type Mounted, panelSuite } from "./harness";

process.env.TZ = "UTC";

const DAY = 86_400_000;
const now = CORPUS_NOW;
const rec = (id: string, extra: Partial<BtwHistoryRecord> = {}): BtwHistoryRecord => ({
	id,
	leafId: null,
	question: `Question ${id} about \`code\` and a fairly long tail of words to wrap`,
	answer: `Answer for ${id}.\n\n- point one\n- point two with **bold**\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n${"More text. ".repeat(20)}`,
	status: "complete",
	createdAt: now - 1000,
	updatedAt: now - 1000,
	...extra,
});
const records: BtwHistoryRecord[] = [
	rec("a", {
		title: "/sitrep",
		followUps: [
			{
				question: "And then?",
				answer: "Then <inject>Stop the build now.</inject> ok",
				status: "complete",
				createdAt: now - 500,
				updatedAt: now - 500,
			},
			{
				question: "Later 日本語?",
				answer: "",
				status: "error",
				error: "network\tdown",
				createdAt: now - 2 * DAY,
				updatedAt: now,
			},
		],
	}),
	rec("b", { status: "running", answer: "Streaming <inject>half a", createdAt: now - 3 * DAY }),
	rec("c", { status: "interrupted", answer: "", createdAt: now - 400 * DAY }),
	rec("d", { status: "cancelled", answer: "short" }),
	rec("e", { status: "error", answer: "", error: "boom" }),
];

interface Env {
	height: number;
	follow: boolean;
	branch: boolean;
	inject: "pending" | "sent" | undefined;
	canSend: boolean;
	accept: boolean;
}

const DOWN = "\x1b[B";
const tick = () => Bun.sleep(0);

function mount(
	initial: readonly BtwHistoryRecord[],
	height: number,
	options: { escapeHides?: boolean; inject?: boolean } = {},
): Mounted {
	const env: Env = { height, follow: true, branch: true, inject: "pending", canSend: true, accept: true };
	const rows = () => env.height;
	const model = new BtwHistoryModel({
		records: initial,
		onClose: () => {},
		onCopy: () => {},
		onCancel: () => {},
		canFollowUp: () => env.follow,
		canBranch: () => env.branch,
		onBranch: () => {},
		onFollowUp: async () => env.accept,
		terminalRows: rows,
		escapeHides: options.escapeHides,
		inject: options.inject ? { state: () => env.inject, canSend: () => env.canSend, send: () => {} } : undefined,
		now: () => now,
	});
	const press =
		(...keys: string[]) =>
		(driver: Driver) => {
			for (const key of keys) driver.press(key);
		};
	const set = (change: (env: Env) => void) => () => {
		change(env);
		// The host re-reads its predicates (follow-up, branch, inject) when they change.
		model.touch();
	};
	const action = (act: string) => (driver: Driver) => void driver.emit({ type: "action", key: "", act, mods: [] });
	// The recording routed the wheel against the frame it drew last (120 columns: the split).
	const wheel = (row: number, col: number) => (driver: Driver) =>
		driver.mouse(decodeMouse(`\x1b[<65;${col + 1};${row + 1}M`)!, 120);
	const heights = (value: number) => set(env => (env.height = value));
	return {
		view: () => <BtwHistoryPanel model={model} />,
		steps: {
			down: press(DOWN),
			tab: press("\t"),
			"scroll down": press(DOWN),
			"page down": press("\x1b[6~"),
			end: press("\x1b[F"),
			home: press("\x1b[H"),
			left: press("\x1b[D"),
			"page down list": press("\x1b[6~"),
			"end list": press("\x1b[F"),
			"home list": press("\x1b[H"),
			"wheel list": wheel(4, 3),
			"wheel reader": wheel(4, 70),
			"copy key": press("c"),
			"mark copied": () => model.markCopied("a", "Answer for a."),
			"branch key": press("b"),
			"no follow/branch": set(env => ((env.follow = false), (env.branch = false))),
			"inject sent": set(env => ((env.inject = "sent"), (env.canSend = false))),
			"height 10": heights(10),
			"height 7": heights(7),
			"height 3": heights(3),
			"height 2": heights(2),
			"height 1": heights(1),
			"height 0": heights(0),
			"height 40": heights(40),
			"height 5": heights(5),
			"follow on": set(env => ((env.follow = true), (env.branch = true), (env.canSend = true))),
			"open follow-up": press("f"),
			type: press("W", "h", "y", "?"),
			paste: driver => driver.paste(" more"),
			"composer scroll": press("\x1b[5~"),
			"native send": async driver => {
				action("send")(driver);
				await tick();
				await tick();
			},
			"open again": () => void model.openFollowUp("a"),
			"submit empty": async driver => {
				driver.press("\r");
				await tick();
			},
			reject: async driver => {
				env.accept = false;
				driver.press("x");
				driver.press("\r");
				await tick();
				await tick();
			},
			"height 9 composer": heights(9),
			"height 3 composer": heights(3),
			"height 40 again": heights(40),
			discard: action("discard"),
			"select native": driver => void driver.emit({ type: "select", key: "history/records", item: "c" }),
			"activate native": driver => void driver.emit({ type: "activate", key: "history/records", item: "a" }),
			"escape composer": press("\x1b"),
			"native stop": action("stop"),
			"native copy": action("copy-answer"),
			"native inject": action("inject"),
			"show b": () => model.showRecord("b"),
			"update streamed": () =>
				model.update(
					records.map(record =>
						record.id === "b" ? { ...record, answer: `${record.answer} more</inject> tail` } : record,
					),
				),
			"update drop selection": () => model.update(records.slice(2)),
			"update single": () => model.update([records[0]!]),
			"update empty": () => model.update([]),
			update: () => model.update(records),
			escape: press("\x1b"),
			unfocus: () => {},
			log: () => {},
		},
	};
}

const CASES: Record<string, () => Mounted> = {
	"many-framed": () => mount(records, 30, { inject: true }),
	"many-hides": () => mount(records, 24, { escapeHides: true, inject: true }),
	single: () => mount([records[1]!], 20, { inject: true }),
	empty: () => mount([], 20),
	keys: () => mount(records, 16, { escapeHides: true }),
};

panelSuite({
	dir: "overlays/btw-history-panel",
	mount(caseName) {
		const build = CASES[caseName];
		if (!build) throw new Error(`unknown case ${caseName}`);
		return build();
	},
});

/** The native tree's nodes (key, kind, props), in tree order. */
function nativeNodes(
	model: BtwHistoryModel,
): { key: string | undefined; kind: string; props: Record<string, unknown> }[] {
	return createRoot(dispose => {
		const out: { key: string | undefined; kind: string; props: Record<string, unknown> }[] = [];
		const walk = (node: UiNode) => {
			out.push({ key: node.key(), kind: node.kind, props: node.props() as Record<string, unknown> });
			for (const child of node.children()) walk(child);
		};
		try {
			for (const node of resolveChildren(() => <BtwHistoryPanel model={model} />)()) walk(node);
			return out;
		} finally {
			dispose();
		}
	});
}

const screenText = (model: BtwHistoryModel) =>
	Bun.stripANSI(printRows(() => <BtwHistoryPanel model={model} />, 80).join("\n"));
const keys = (model: BtwHistoryModel) => nativeNodes(model).map(node => node.key);

function sheetModel(extra: Partial<BtwHistoryOptions> = {}): BtwHistoryModel {
	return new BtwHistoryModel({
		records: [],
		onClose: () => {},
		onCopy: () => {},
		onCancel: () => {},
		terminalRows: () => 30,
		now: () => now,
		...extra,
	});
}

afterEach(() => setNativeRenderingForTest(false));

describe("BtwHistoryModel with host texts and new topics", () => {
	it("starts a new topic from an empty sheet with custom texts, natively and in text", async () => {
		const accepted = Promise.withResolvers<boolean>();
		const onStart = vi.fn((_question: string, _signal: AbortSignal) => accepted.promise);
		const onPasteImage = vi.fn(async () => {});
		const model = sheetModel({
			texts: { heading: "Ask peer", role: "omp.overlay.ask", emptyTitle: "No questions yet", emptyHint: "Press n." },
			onStart,
			onPasteImage,
		});
		expect(btwHistorySheet(model)).toMatchObject({ role: "omp.overlay.ask", head: "Ask peer" });
		const empty = nativeNodes(model);
		expect(empty.map(node => node.key)).toContain("empty");
		expect(empty.map(node => node.key)).toContain("start");
		expect(empty.find(node => node.props.role === "omp.btw.empty.hint")?.props.spans).toEqual([{ t: "Press n." }]);
		const screen = screenText(model);
		expect(screen).toContain("Ask peer");
		expect(screen).toContain("No questions yet.");
		expect(screen).toContain("Press n.");
		expect(screen).toContain("n new");

		model.action("start");
		expect(model.openStart()).toBe(false);
		expect(keys(model)).toContain("composer");
		const composing = screenText(model);
		expect(composing).toContain("Ask: ");
		expect(composing).not.toContain("Topic:");
		expect(nativeNodes(model).find(node => node.kind === "input")?.props).toMatchObject({
			prompt: "Ask: ",
			placeholder: "Type a question…",
		});
		// A record update never drops the new-topic composer.
		model.update([]);
		expect(keys(model)).toContain("composer");
		// A new topic takes text only: no image attaches and an empty paste reads no clipboard image.
		expect(model.attachImage({ type: "image", data: "", mimeType: "image/png" })).toBeUndefined();
		model.paste("");
		expect(onPasteImage).not.toHaveBeenCalled();

		model.paste("what changed?");
		model.key(keyEvent("enter"));
		expect(onStart.mock.calls[0]?.[0]).toBe("what changed?");
		// The host adds and shows the new record before accepting.
		model.update([rec("n", { question: "what changed?" })]);
		model.showRecord("n");
		accepted.resolve(true);
		await tick();
		const done = nativeNodes(model);
		expect(done.map(node => node.key)).not.toContain("composer");
		expect(done.some(node => node.kind === "md" && node.props.text === "what changed?")).toBe(true);
		expect(model.selectedId).toBe("n");
	});

	it("keeps a refused new topic's draft with a retry notice", async () => {
		const model = sheetModel({ onStart: async () => false });
		model.key(keyEvent("n"));
		model.key(keyEvent("enter"));
		expect(model.composer?.notice).toBe("Enter a question.");
		model.paste("why?");
		await model.submitFollowUp();
		expect(model.composer?.draft.text).toBe("why?");
		expect(model.composer?.notice).toStartWith("Question was not started.");
	});

	it("offers New question beside the answer's actions while a topic is shown", () => {
		setNativeRenderingForTest(true);
		const model = sheetModel({ records: [rec("a")], onStart: async () => true });
		expect(keys(model)).toContain("start");
		model.key(keyEvent("n"));
		// Natively the new topic's composer takes the reader's place.
		const nodes = keys(model);
		expect(nodes).toContain("composer");
		expect(nodes).not.toContain("thread");
	});

	it("keeps painting the selected topic in the terminal while a new topic is written", () => {
		const model = sheetModel({
			records: [rec("a", { question: "What is up", answer: "Everything is fine here." })],
			onStart: async () => true,
		});
		expect(screenText(model)).toContain("Everything is fine here.");
		model.key(keyEvent("n"));
		const screen = screenText(model);
		expect(screen).toContain("What is up");
		expect(screen).toContain("Everything is fine here.");
		expect(screen).toContain("Ask: ");
	});

	it("attaches images only to a follow-up of a host that takes them", () => {
		const image = { type: "image" as const, data: "", mimeType: "image/png" };
		const meshStyle = sheetModel({ records: [rec("a")], canFollowUp: () => true, onFollowUp: async () => true });
		expect(meshStyle.openFollowUp("a")).toBe(true);
		expect(meshStyle.attachImage(image)).toBeUndefined();
		const btwStyle = sheetModel({
			records: [rec("a")],
			canFollowUp: () => true,
			onFollowUp: async () => true,
			onPasteImage: async () => {},
		});
		expect(btwStyle.openFollowUp("a")).toBe(true);
		expect(btwStyle.attachImage(image)).toBe("[Image #1]");
	});

	it("keeps the /btw empty state and offers no new topic without onStart", () => {
		const model = sheetModel();
		expect(btwHistorySheet(model)).toMatchObject({ role: "omp.overlay.btwHistory", head: "BTW history" });
		expect(model.openStart()).toBe(false);
		expect(model.key(keyEvent("n"))).toBe(false);
		const nodes = nativeNodes(model);
		expect(nodes.map(node => node.key)).not.toContain("composer");
		expect(nodes.map(node => node.key)).not.toContain("start");
		expect(JSON.stringify(nodes.find(node => node.props.role === "omp.btw.empty.hint")?.props.spans)).toContain(
			"/btw <question>",
		);
		const screen = screenText(model);
		expect(screen).toContain("Use /btw QUESTION to start one.");
		expect(screen).not.toContain("n new");
	});

	it("names a running turn with the host's labels", () => {
		const model = sheetModel({
			records: [rec("r", { status: "running", answer: "" })],
			texts: { runningBadge: "Waiting", pendingText: "Waiting for the agent…", stop: "Stop waiting" },
		});
		const screen = screenText(model);
		expect(screen).toContain("Waiting · ");
		expect(screen).toContain("Waiting for the agent…");
		expect(nativeNodes(model).find(node => node.key === "stop")?.props.title).toStartWith("Stop waiting");
	});
});

describe("BtwHistoryModel plainAnswers", () => {
	const LINK = "see [docs](https://evil.example) now";
	const open = (plainAnswers?: boolean) =>
		sheetModel({ records: [rec("a", { question: "q", answer: LINK })], plainAnswers });
	/** The answer column's content node (the next node in tree order). */
	const answerContent = (model: BtwHistoryModel) => {
		const nodes = nativeNodes(model);
		return nodes[nodes.findIndex(node => node.key === "answer") + 1];
	};

	it("renders a link-bearing answer as plain text natively and keeps the question markdown", () => {
		const model = open(true);
		expect(answerContent(model)).toMatchObject({ kind: "text", props: { text: LINK } });
		expect(nativeNodes(model).some(node => node.kind === "md" && node.props.text === "q")).toBe(true);
	});

	it("renders a link-bearing answer as plain text in the terminal", () => {
		expect(screenText(open(true))).toContain(LINK);
	});

	it("keeps markdown answers by default", () => {
		const model = open();
		expect(answerContent(model)?.kind).toBe("md");
		expect(screenText(model)).not.toContain(LINK);
	});
});
