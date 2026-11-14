/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/mesh` manager contracts: section/row model (side gating, hidden filter, ordering),
 * sanitization of untrusted peer text, compose refusal for blocked peers, and the key-driven
 * actions (enable, mode cycle, approvals, hide/block, compose, confirmed key phrase) against a fake
 * runtime on the terminal page, plus the Tern picker contracts (details back-out, pinned approval
 * selection, compose strip, masked key phrase field, details threads).
 */
import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { fullscreenMenuView, layerContent } from "../../../../src/modes/controllers/selector-views";
import { meshSenderLabel } from "../../../../src/modes/view-model/overlays/mesh-display";
import {
	buildMeshManagerSections,
	compareMeshPeers,
	fitMeshHints,
	MESH_CHANGE_COALESCE_MS,
	meshManagerItems,
	sanitizeMeshManagerState,
} from "../../../../src/modes/view-model/overlays/mesh-manager";
import type {
	MeshComposeKind,
	MeshManagerMode,
	MeshManagerPeer,
	MeshManagerRuntime,
	MeshManagerState,
	MeshManagerThread,
	MeshSendOutcome,
} from "../../../../src/modes/view-model/overlays/mesh-manager-types";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { MeshManager } from "../../../../src/ui/overlays/mesh-manager/mesh-manager";
import { MeshManagerModel } from "../../../../src/ui/overlays/mesh-manager/model";
import { mountOverlay } from "../../../helpers/overlay-terminal";
import { nativeShell } from "../../../helpers/native-shell";

const NOW = 1_800_000_000_000;

function peer(overrides: Partial<MeshManagerPeer> & Pick<MeshManagerPeer, "instanceId">): MeshManagerPeer {
	return {
		endpointKind: "local",
		endpoint: "local",
		source: "local",
		state: "online",
		lastSeen: NOW,
		hidden: false,
		blocked: false,
		displayName: overrides.instanceId,
		host: "host",
		cwd: "/work",
		busy: false,
		agents: [],
		...overrides,
	};
}

class FakeRuntime implements MeshManagerRuntime {
	state: MeshManagerState;
	readonly calls: string[] = [];
	readonly listeners = new Set<() => void>();
	threads: readonly MeshManagerThread[] = [];
	/** The last async action's promise; the manager's continuation runs before an await on it resumes. */
	pending: Promise<unknown> = Promise.resolve();

	constructor(state: MeshManagerState) {
		this.state = state;
	}
	getState(): MeshManagerState {
		return this.state;
	}
	subscribe(onChange: () => void): () => void {
		this.listeners.add(onChange);
		return () => this.listeners.delete(onChange);
	}
	setEnabled(enabled: boolean): void {
		this.calls.push(`enabled=${enabled}`);
		this.state = { ...this.state, enabled };
	}
	setMode(mode: MeshManagerMode): void {
		this.calls.push(`mode=${mode}`);
		this.state = { ...this.state, mode };
	}
	setKeyPhrase(phrase: string): Promise<void> {
		this.calls.push(`key=${phrase}`);
		const pending = Promise.resolve();
		this.pending = pending;
		return pending;
	}
	setPeerFlags(instanceId: string, flags: { hidden?: boolean; blocked?: boolean }): void {
		this.calls.push(`flags ${instanceId} ${JSON.stringify(flags)}`);
	}
	resolveApproval(id: string, allow: boolean): void {
		this.calls.push(`approval ${id} ${allow}`);
		this.state = { ...this.state, approvals: this.state.approvals.filter(entry => entry.id !== id) };
	}
	refresh(): void {
		this.calls.push("refresh");
	}
	listThreads(): Promise<readonly MeshManagerThread[]> {
		const pending = Promise.resolve(this.threads);
		this.pending = pending;
		return pending;
	}
	send(peerInstanceId: string, kind: MeshComposeKind, text: string): Promise<MeshSendOutcome> {
		this.calls.push(`send ${peerInstanceId} ${kind} ${text}`);
		const pending = Promise.resolve<MeshSendOutcome>({ ok: true, thread: "t1" });
		this.pending = pending;
		return pending;
	}
	/** A runtime change, as the engine reports it. */
	change(state: MeshManagerState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

function baseState(): MeshManagerState {
	return {
		enabled: true,
		mode: "both",
		hasKey: true,
		self: { instanceId: "self-id", displayName: "me", status: { local: "on", remote: "on", lanPort: 7311 } },
		peers: [
			peer({ instanceId: "b", displayName: "beta", sessionName: "refactor", busy: true }),
			peer({ instanceId: "a", displayName: "alpha", summary: "line1\nline2\x1b]0;evil\x07 \x1b[31mred" }),
			peer({ instanceId: "h", displayName: "hidden-one", hidden: true }),
			peer({
				instanceId: "r",
				displayName: "remote\tbox",
				endpointKind: "remote",
				endpoint: "remote 10.0.0.2 · box.lan",
			}),
		],
		approvals: [
			{
				id: "ap1",
				kind: "ask",
				fromName: "carol",
				fromHost: "laptop",
				fromAgent: "Main",
				fromInstanceId: "c",
				preview: "what are you doing?",
				expiresAt: NOW + 60_000,
			},
		],
	};
}

const now = () => NOW;
const mounted: TestTerminal[] = [];

/** The manager on a terminal, mounted as `/mesh` mounts it (a fullscreen menu, keys on the picker). */
function mount(state: MeshManagerState, options: { onAsk?: (id: string) => void } = {}) {
	const runtime = new FakeRuntime(state);
	let closed = false;
	const term = mountOverlay(
		() =>
			fullscreenMenuView(
				"mesh-manager",
				<MeshManager
					runtime={runtime}
					now={now}
					onClose={() => {
						closed = true;
					}}
					{...options}
				/>,
			),
		{ columns: 100, rows: 40 },
	);
	mounted.push(term);
	const screen = () => term.screen().join("\n");
	return { runtime, term, screen, closed: () => closed };
}

afterEach(() => {
	for (const term of mounted.splice(0)) term.dispose();
	vi.useRealTimers();
});

describe("mesh manager row model", () => {
	test("gates sides by mode and filters hidden peers unless shown", () => {
		const state = { ...baseState(), mode: "local" as const };
		const sections = buildMeshManagerSections(state, false);
		expect(sections.map(section => [section.id, section.enabled, section.items.length])).toEqual([
			["approvals", true, 1],
			["local", true, 2],
			["remote", false, 1],
		]);
		expect(sections[1]!.hiddenCount).toBe(1);
		// Disabled sides contribute no selectable rows.
		expect(meshManagerItems(sections).map(item => item.key)).toEqual(["approval:ap1", "peer:a", "peer:b"]);
		expect(buildMeshManagerSections(state, true)[1]!.items.map(item => item.key)).toEqual([
			"peer:a",
			"peer:b",
			"peer:h",
		]);
	});

	test("orders online before stale, visible before hidden, then by name", () => {
		const peers = [
			peer({ instanceId: "1", displayName: "zed", state: "stale" }),
			peer({ instanceId: "2", displayName: "Bob", hidden: true }),
			peer({ instanceId: "3", displayName: "amy" }),
			peer({ instanceId: "4", displayName: "Carl" }),
		];
		expect(peers.sort(compareMeshPeers).map(entry => entry.instanceId)).toEqual(["3", "4", "2", "1"]);
	});

	test("sanitizes every peer string once, keeping summary lines; strips bidi controls", () => {
		const safe = sanitizeMeshManagerState(baseState());
		const alpha = safe.peers.find(entry => entry.instanceId === "a")!;
		expect(alpha.summary).toBe("line1\nline2 red");
		expect(safe.peers.find(entry => entry.instanceId === "r")!.displayName).not.toContain("\t");
		const strings = JSON.stringify(safe);
		expect(strings).not.toContain("\\u001b");
		expect(strings).not.toContain("\\u0007");

		const spoof = {
			...baseState(),
			peers: [peer({ instanceId: "s", displayName: "a\u202Eb\u2066c\u200Fd\u061Ce", summary: "x\u202Dy" })],
		};
		const spoofed = sanitizeMeshManagerState(spoof).peers[0]!;
		expect(spoofed.displayName).toBe("abcde");
		expect(spoofed.summary).toBe("xy");
	});

	test("footer hints keep the leading hint and mark cut ones", () => {
		const hints = ["esc close", "aaaa", "bbbb", "cccc", "dddd"];
		expect(fitMeshHints(hints, 80, 2)).toEqual(["esc close · aaaa · bbbb · cccc · dddd"]);
		const narrow = fitMeshHints(hints, 16, 2);
		expect(narrow).toHaveLength(2);
		expect(narrow[0]).toBe("esc close · aaaa");
		expect(narrow[1]!.endsWith("…")).toBe(true);
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(16);
	});

	test("sender label omits a host the display name already carries", () => {
		expect(meshSenderLabel("apoc@nymfe", "nymfe")).toBe("apoc@nymfe");
		expect(meshSenderLabel("apoc", "nymfe")).toBe("apoc@nymfe");
		expect(meshSenderLabel("apoc", "")).toBe("apoc");
	});
});

describe("mesh manager in a terminal", () => {
	test("paints a full-height, full-width page free of peer control sequences", () => {
		const { term, screen } = mount(baseState());
		const raw = term.rows();
		expect(raw).toHaveLength(40);
		for (const line of raw) expect(visibleWidth(line)).toBe(100);
		const text = raw.join("\n");
		expect(text).not.toContain("\x1b]0;");
		expect(text).not.toContain("\x07");
		expect(text).not.toContain("\t");
		const page = screen();
		expect(page).toContain("Pending approvals (1)");
		expect(page).toContain("Local (2) · 1 hidden (v)");
		expect(page).toContain("mode both · local on · remote on · LAN :7311");
		expect(page).toContain("esc close · ↑↓ select");
		// Local peers sort by name: alpha before beta.
		expect(page.indexOf("alpha")).toBeLessThan(page.indexOf("beta"));
	});

	test("a long self-declared name cannot push the approval's instance id off the row", () => {
		const state = baseState();
		const approval = { ...state.approvals[0]!, fromName: "x".repeat(1000), fromAgent: "y".repeat(1000) };
		const { term } = mount({ ...state, approvals: [approval] });
		const header = term.screen().find(line => line.includes("x".repeat(10)));
		expect(header).toContain(`${approval.fromInstanceId} · expires in 1m0s`);
	});

	test("e enables a disabled mesh; peer actions wait until it is on", () => {
		const { term, runtime, screen } = mount({ ...baseState(), enabled: false });
		expect(screen()).toContain("Mesh is disabled.");
		term.press("h");
		term.press("c");
		expect(runtime.calls).toEqual([]);
		term.press("e");
		expect(runtime.calls).toEqual(["enabled=true"]);
		expect(screen()).toContain("Mesh enabled");
	});

	test("approves the selected approval and acts on the selected peer", () => {
		const { term, runtime } = mount(baseState());
		term.press("a");
		expect(runtime.calls).toEqual(["approval ap1 true"]);
		// The approval left the list; the first local peer is selected now.
		term.press("h");
		term.press("down");
		term.press("b");
		expect(runtime.calls.slice(1)).toEqual([`flags a {"hidden":true}`, `flags b {"blocked":true}`]);
	});

	test("d denies the selected approval", () => {
		const { term, runtime, screen } = mount(baseState());
		term.press("d");
		expect(runtime.calls).toEqual(["approval ap1 false"]);
		expect(screen()).toContain("Denied ask from carol");
	});

	test("a, a approves two queued approvals in the order drawn", () => {
		const state = baseState();
		const second = { ...state.approvals[0]!, id: "ap2", fromName: "dave", fromInstanceId: "d" };
		const { term, runtime, screen } = mount({ ...state, approvals: [state.approvals[0]!, second] });
		term.press("a");
		expect(screen()).toContain("› ask d · expires in");
		term.press("a");
		expect(runtime.calls).toEqual(["approval ap1 true", "approval ap2 true"]);
		expect(screen()).toContain("Approved ask from dave");
	});

	test("m cycles the mode and points at the missing key", () => {
		const { term, runtime, screen } = mount({ ...baseState(), mode: "local", hasKey: false });
		term.press("m");
		expect(screen()).toContain("Mesh mode: remote (remote needs a key phrase: press k)");
		term.press("m");
		term.press("m");
		expect(runtime.calls).toEqual(["mode=remote", "mode=both", "mode=local"]);
	});

	test("v shows hidden peers", () => {
		const { term, screen } = mount(baseState());
		expect(screen()).not.toContain("hidden-one");
		term.press("v");
		expect(screen()).toContain("hidden-one");
		expect(screen()).toContain("Showing hidden peers");
	});

	test("compose sends the chosen kind to the selected peer", async () => {
		const { term, runtime, screen } = mount({ ...baseState(), approvals: [] });
		term.press("c");
		expect(screen()).toContain("Message alpha: choose a kind");
		term.press("right"); // → ask
		term.press("enter");
		term.type("hi there");
		expect(screen()).toContain("> hi there");
		term.press("enter");
		await runtime.pending;
		expect(runtime.calls).toEqual(["send a ask hi there"]);
		term.render();
		expect(screen()).toContain("Sent ask to alpha (thread t1)");
	});

	test("compose to a blocked peer only sends notes", async () => {
		const state = { ...baseState(), approvals: [], peers: [peer({ instanceId: "x", blocked: true })] };
		const { term, runtime, screen } = mount(state);
		term.press("c");
		term.press("1"); // status: refused, the kind picker stays
		expect(screen()).toContain("x is blocked, so its answer could never arrive.");
		term.type("nope");
		term.press("4"); // note
		term.type("fyi");
		term.press("enter");
		await runtime.pending;
		expect(runtime.calls).toEqual(["send x note fyi"]);
	});

	test("key phrase must be entered twice, masked; a mismatch derives nothing; short phrases warn", async () => {
		const { term, runtime, screen } = mount(baseState());
		term.press("k");
		term.type("short");
		expect(screen()).toContain("Too short: the mesh requires at least");
		for (let i = 0; i < 5; i++) term.press("backspace");
		term.type("correct horse battery");
		term.press("enter");
		expect(screen()).toContain("Repeat the key phrase");
		term.type("correct horse batterx");
		term.press("enter");
		expect(runtime.calls).toEqual([]);
		expect(screen()).toContain("The phrases do not match; enter it again");
		// Back at the first step after a mismatch.
		term.type("correct horse battery");
		term.press("enter");
		term.type("correct horse battery");
		expect(screen()).not.toContain("correct horse");
		expect(screen()).toContain("•".repeat(21));
		term.press("enter");
		await runtime.pending;
		expect(runtime.calls).toEqual(["key=correct horse battery"]);
	});

	test("enter opens a peer's details with its threads; esc goes back, then closes", async () => {
		const { term, runtime, screen, closed } = mount({ ...baseState(), approvals: [] });
		runtime.threads = [
			{ threadId: "th\x1b[31m1", kind: "ask", turns: 2, status: "open", lastQuestion: "why?", updatedAt: NOW },
		];
		term.press("enter");
		await runtime.pending;
		term.render();
		const page = screen();
		expect(page).toContain("Threads from this peer (1)");
		expect(page).toContain("th1 ask · 2 turns · open · now — why?");
		expect(page).toContain("line2 red");
		expect(page).toContain("esc back · ↑↓ scroll");
		term.press("escape");
		expect(closed()).toBe(false);
		expect(screen()).toContain("esc close");
		term.press("escape");
		expect(closed()).toBe(true);
	});

	test("runtime changes re-render live (coalesced) and closing unsubscribes", async () => {
		vi.useFakeTimers();
		const { term, runtime, screen, closed } = mount({ ...baseState(), approvals: [] });
		runtime.change({ ...runtime.state, peers: [peer({ instanceId: "0", displayName: "zero" })] });
		term.press("c");
		term.press("4");
		term.type("x");
		term.press("enter");
		// Before the coalesced pull the selection still resolves against the old peers.
		expect(runtime.calls).toEqual(["send a note x"]);
		await runtime.pending;
		vi.advanceTimersByTime(150);
		term.render();
		expect(screen()).toContain("zero");
		term.press("c");
		term.press("4");
		term.type("y");
		term.press("enter");
		expect(runtime.calls).toEqual(["send a note x", "send 0 note y"]);
		await runtime.pending;
		term.press("escape");
		expect(closed()).toBe(true);
		expect(runtime.listeners.size).toBe(0);
	});

	test("an overlay closed from outside unsubscribes from the runtime", () => {
		const { term, runtime } = mount(baseState());
		expect(runtime.listeners.size).toBe(1);
		term.dispose();
		expect(runtime.listeners.size).toBe(0);
	});

	test("a paste lands on one line in the open prompt, masked for the key phrase", async () => {
		const { term, runtime, screen } = mount(baseState());
		term.press("k");
		term.paste("correct horse\nbattery\r\n");
		expect(screen()).not.toContain("correct");
		expect(screen()).toContain(`> ${"•".repeat(20)}`);
		term.press("enter");
		term.paste("correct horsebattery");
		term.press("enter");
		await runtime.pending;
		expect(runtime.calls).toEqual(["key=correct horsebattery"]);
	});
});

describe("mesh manager on Tern", () => {
	async function tern(state: MeshManagerState, options: { onAsk?: (id: string) => void; closed?: string[] } = {}) {
		const ui = await nativeShell();
		const runtime = new FakeRuntime(state);
		const events = options.closed ?? [];
		ui.shell.overlays.show(
			() =>
				fullscreenMenuView(
					"mesh-manager",
					<MeshManager
						runtime={runtime}
						now={now}
						onClose={() => events.push("close")}
						{...(options.onAsk ? { onAsk: options.onAsk } : {})}
					/>,
				),
			{ focus: root => layerContent(root) },
		);
		const props = (): TspPickerProps => ui.node("picker").p as TspPickerProps;
		const act = (name: string, value?: string) =>
			ui.send({ ev: "action", sf: ui.sf, id: ui.node("picker").id, act: name, ...(value ? { value } : {}) });
		const pick = (ev: "select" | "activate", item: string) =>
			ui.send({ ev, sf: ui.sf, id: ui.node("picker").id, item });
		return { ui, runtime, props, act, pick, events };
	}

	test("details open in the preview; the close action backs out of them before closing", async () => {
		const { ui, props, act, pick, events } = await tern({ ...baseState(), mode: "local" });
		await using _ = ui;
		expect(props().order).toContainEqual(expect.objectContaining({ group: "remote" }));
		// The side the mode does not reach shows a disabled row that selects nothing.
		expect(props().items?.find(item => item.id === "off:remote")?.disabled).toBeTruthy();
		pick("select", "off:remote");
		expect(props().selected).toBe("approval:ap1");

		pick("activate", "peer:b");
		expect(props()).toMatchObject({ selected: "peer:b", focus: "preview" });
		expect(props().actions?.at(-1)).toMatchObject({ id: "close", label: "Back" });

		act("close");
		expect(props().focus).toBe("list");
		expect(events).toEqual([]);
		act("close");
		expect(events).toEqual(["close"]);
	});

	test("Ask closes the manager, then hands the target peer to onAsk; blocked peers are refused", async () => {
		const events: string[] = [];
		const state = {
			...baseState(),
			approvals: [],
			peers: [peer({ instanceId: "a", displayName: "alpha" }), peer({ instanceId: "x", blocked: true })],
		};
		const { ui, props, act, pick } = await tern(state, { onAsk: id => events.push(`ask ${id}`), closed: events });
		await using _ = ui;
		expect(props().actions?.find(action => action.id === "q")).toMatchObject({ label: "Ask" });
		pick("select", "peer:x");
		expect(props().actions?.find(action => action.id === "q")?.disabled).toBeString();
		act("q");
		expect(events).toEqual([]);
		pick("select", "peer:a");
		act("q");
		expect(events).toEqual(["close", "ask a"]);
	});

	test("Tern never builds the terminal page", async () => {
		const page = spyOn(MeshManagerModel.prototype, "page");
		const { ui, act } = await tern(baseState());
		await using _ = ui;
		for (const name of ["v", "v", "m"]) act(name);
		expect(page).not.toHaveBeenCalled();
		page.mockRestore();
	});

	test("offers no Ask without onAsk", async () => {
		const { ui, props } = await tern(baseState());
		await using _ = ui;
		expect(props().actions?.some(action => action.id === "q")).toBe(false);
	});

	test("Approve resolves the approval drawn selected, never one the user has not seen", async () => {
		const { ui, runtime, props, act } = await tern(baseState());
		await using _ = ui;
		vi.useFakeTimers();
		try {
			expect(props().selected).toBe("approval:ap1");
			// The selected request goes away and a newer one takes the first row.
			const newer = { ...runtime.state.approvals[0]!, id: "ap0", kind: "task", fromName: "mallory" };
			runtime.change({ ...runtime.state, approvals: [newer] });
			// Before the coalesced pull the old frame stands: Approve resolves the request drawn selected.
			act("a");
			expect(runtime.calls).toEqual(["approval ap1 true"]);
			vi.advanceTimersByTime(MESH_CHANGE_COALESCE_MS + 20);
			// Once drawn selected, the fallback row is the selection Approve resolves.
			expect(props().selected).toBe("approval:ap0");
			act("a");
			expect(runtime.calls).toEqual(["approval ap1 true", "approval ap0 true"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a/d in details never resolve the approval the picker fell back to", async () => {
		const { ui, runtime, props, act, pick } = await tern(baseState());
		await using _ = ui;
		vi.useFakeTimers();
		try {
			pick("activate", "peer:a");
			// The open peer leaves the list, so the picker's selection falls back to the first row.
			runtime.change({ ...runtime.state, peers: runtime.state.peers.filter(entry => entry.instanceId !== "a") });
			vi.advanceTimersByTime(MESH_CHANGE_COALESCE_MS + 20);
			expect(props().selected).toBe("approval:ap1");
			act("a");
			act("d");
			expect(runtime.calls).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("the key phrase prompt works while the mesh is disabled", async () => {
		const { ui, runtime, props, act } = await tern({ ...baseState(), enabled: false, approvals: [] });
		await using _ = ui;
		act("k");
		expect(props().focus).toBe("preview");
		expect(props().actions?.map(action => action.id)).toEqual(["submit", "close"]);
		const edit = (text: string) =>
			ui.send({ ev: "edit", sf: ui.sf, id: ui.node("input").id, from: 0, to: 0, text, cursor: text.length, len: 0 });
		// While the prompt is open only Submit and Cancel act: a stray Enable click does nothing.
		act("e");
		expect(runtime.calls).toEqual([]);
		edit("correct horse battery");
		act("submit");
		edit("correct horse battery");
		act("submit");
		await runtime.pending;
		expect(runtime.calls).toEqual(["key=correct horse battery"]);
		expect(props().focus).toBe("list");
		expect(props().actions?.[0]).toMatchObject({ id: "e", label: "Enable" });
	});

	test("compose picks a kind on the strip, then sends from the preview's field", async () => {
		const { ui, runtime, props, act } = await tern({ ...baseState(), approvals: [] });
		await using _ = ui;
		act("c");
		expect(props().focus).toBe("strip");
		expect(props().strip?.items.map(item => item.label)).toEqual(["status", "ask", "steer", "note"]);

		act("strip", "1");
		expect(props().focus).toBe("preview");
		expect(props().strip ?? null).toBeNull();
		const field = ui.node("input");
		ui.send({ ev: "edit", sf: ui.sf, id: field.id, from: 0, to: 0, text: "what is 4*4?", cursor: 12, len: 0 });
		expect(ui.node("input").p).toMatchObject({ text: "what is 4*4?" });
		act("submit");
		await runtime.pending;
		expect(runtime.calls).toEqual(["send a ask what is 4*4?"]);
		expect(props().focus).toBe("list");
	});

	test("the key phrase never reaches the native tree", async () => {
		const { ui, runtime, act } = await tern(baseState());
		await using _ = ui;
		act("k");
		const edit = (text: string) =>
			ui.send({
				ev: "edit",
				sf: ui.sf,
				id: ui.node("input").id,
				from: 0,
				to: 0,
				text,
				cursor: text.length,
				len: 0,
			});
		edit("correct horse battery");
		act("submit");
		edit("correct horse battery");
		const tree = JSON.stringify(ui.tree(ui.node("picker").id));
		expect(tree).not.toContain("correct horse");
		expect(tree).toContain("•".repeat(21));
		act("submit");
		await runtime.pending;
		expect(runtime.calls).toEqual(["key=correct horse battery"]);
	});
});
