/**
 * `/mesh` manager contracts: section/row model (side gating, hidden filter, ordering), peer
 * counts, sanitization of untrusted peer text, compose refusal for blocked peers, and the
 * key-driven actions (enable, mode cycle, approvals, hide/block, compose, confirmed key phrase)
 * against a fake runtime, plus the Tern picker/prompt-card contracts (details back-out, pinned
 * approval selection, compose strip, masked key phrase, rows fallback without pickers).
 */
import { beforeAll, describe, expect, test, vi } from "bun:test";
import {
	buildMeshManagerSections,
	compareMeshPeers,
	countMeshPeers,
	fitMeshHints,
	MeshManagerComponent,
	meshComposeRefusal,
	meshManagerItems,
	meshSenderLabel,
	sanitizeMeshManagerState,
} from "../src/overlays/mesh-manager";
import type {
	MeshComposeKind,
	MeshManagerMode,
	MeshManagerPeer,
	MeshManagerRuntime,
	MeshManagerState,
	MeshSendOutcome,
} from "../src/overlays/mesh-manager-types";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { initTheme } from "../src/theme";
import { visibleWidth } from "../src/utils";
import type { TspKind, TspPickerProps } from "@oh-my-pi/pi-wire";

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const withoutPicker: DescribeContext = { ...pickerCx, supports: (kind: TspKind) => kind !== "picker" };

function pickerProps(manager: MeshManagerComponent): TspPickerProps {
	expect(manager.nativeSheet(pickerCx)).toBe(true);
	const root = manager.describe(pickerCx);
	if (root?.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root?.k}`);
	return root.p;
}

/** Every described node, child components (the prompt's `Input`) expanded through their own `describe`. */
function nodes(child: NativeChild | null): NativeNode[] {
	if (!child) return [];
	if (!("k" in child)) return nodes(child.describe?.(pickerCx) ?? null);
	return [child, ...(child.c ?? []).flatMap(nodes)];
}

function act(manager: MeshManagerComponent, name: string, value?: string): void {
	manager.handleNativeEvent({ type: "action", key: "", act: name, value, mods: [] });
}

function peer(overrides: Partial<MeshManagerPeer> & Pick<MeshManagerPeer, "instanceId">): MeshManagerPeer {
	return {
		endpointKind: "local",
		endpoint: "local",
		source: "local",
		state: "online",
		lastSeen: Date.now(),
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
	/** The last async action's promise; the component's continuation runs before an await on it resumes. */
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
	async listThreads() {
		return [];
	}
	send(peerInstanceId: string, kind: MeshComposeKind, text: string): Promise<MeshSendOutcome> {
		this.calls.push(`send ${peerInstanceId} ${kind} ${text}`);
		const pending = Promise.resolve<MeshSendOutcome>({ ok: true, thread: "t1" });
		this.pending = pending;
		return pending;
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
				expiresAt: Date.now() + 60_000,
			},
		],
	};
}

function mount(state: MeshManagerState) {
	const runtime = new FakeRuntime(state);
	let closed = false;
	const manager = new MeshManagerComponent(runtime, {
		requestRender: () => {},
		rows: () => 40,
		onClose: () => {
			closed = true;
		},
	});
	return { runtime, manager, closed: () => closed };
}

function typeText(manager: MeshManagerComponent, text: string): void {
	for (const ch of text) manager.handleInput(ch);
}

beforeAll(async () => {
	await initTheme();
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

	test("counts only visible, unblocked, online peers per side", () => {
		expect(
			countMeshPeers([
				peer({ instanceId: "1" }),
				peer({ instanceId: "2", hidden: true }),
				peer({ instanceId: "3", blocked: true }),
				peer({ instanceId: "4", state: "stale" }),
				peer({ instanceId: "5", endpointKind: "remote" }),
			]),
		).toEqual({ local: 1, remote: 1 });
	});

	test("sanitizes every peer string once, keeping summary lines and raw ids for actions", () => {
		const safe = sanitizeMeshManagerState(baseState());
		const alpha = safe.peers.find(entry => entry.instanceId === "a")!;
		expect(alpha.summary).toBe("line1\nline2 red");
		expect(safe.peers.find(entry => entry.instanceId === "r")!.displayName).not.toContain("\t");
		const strings = JSON.stringify(safe);
		expect(strings).not.toContain("\\u001b");
		expect(strings).not.toContain("\\u0007");
	});

	test("strips bidi controls from peer text", () => {
		const state = baseState();
		const spoof = {
			...state,
			peers: [peer({ instanceId: "s", displayName: "a\u202Eb\u2066c\u200Fd\u061Ce", summary: "x\u202Dy" })],
		};
		const safe = sanitizeMeshManagerState(spoof).peers[0]!;
		expect(safe.displayName).toBe("abcde");
		expect(safe.summary).toBe("xy");
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

	test("refuses non-note compose to blocked peers", () => {
		const blocked = peer({ instanceId: "x", blocked: true });
		expect(meshComposeRefusal(blocked, "ask")).toBeString();
		expect(meshComposeRefusal(blocked, "note")).toBeUndefined();
		expect(meshComposeRefusal(peer({ instanceId: "y" }), "steer")).toBeUndefined();
	});

	test("sender label omits a host the display name already carries", () => {
		expect(meshSenderLabel("apoc@nymfe", "nymfe")).toBe("apoc@nymfe");
		expect(meshSenderLabel("apoc", "nymfe")).toBe("apoc@nymfe");
		expect(meshSenderLabel("apoc", "")).toBe("apoc");
	});
});

describe("mesh manager component", () => {
	test("renders a full-height, full-width frame free of peer control sequences", () => {
		const { manager } = mount(baseState());
		const raw = manager.render(100);
		expect(raw).toHaveLength(40);
		for (const line of raw) expect(visibleWidth(line)).toBe(100);
		const rendered = raw.join("\n");
		expect(rendered).not.toContain("\x1b]0;");
		expect(rendered).not.toContain("\x07");
		expect(rendered).not.toContain("\t");
		manager.dispose();
	});

	test("a long self-declared name cannot push the approval's instance id off the row", () => {
		const state = baseState();
		const approval = { ...state.approvals[0]!, fromName: "x".repeat(1000), fromAgent: "y".repeat(1000) };
		const { manager } = mount({ ...state, approvals: [approval] });
		const header = manager.render(80).find(line => line.includes("x".repeat(10)));
		expect(Bun.stripANSI(header ?? "")).toContain(`${approval.fromInstanceId} · expires in`);
		manager.dispose();
	});

	test("e enables a disabled mesh; peer actions wait until it is on", () => {
		const { manager, runtime } = mount({ ...baseState(), enabled: false });
		manager.handleInput("h");
		manager.handleInput("c");
		expect(runtime.calls).toEqual([]);
		manager.handleInput("e");
		expect(runtime.calls).toEqual(["enabled=true"]);
		manager.dispose();
	});

	test("approves the selected approval and acts on the selected peer", () => {
		const { manager, runtime } = mount(baseState());
		manager.handleInput("a");
		expect(runtime.calls).toEqual(["approval ap1 true"]);
		// The approval left the list; the first local peer is selected now.
		manager.render(100);
		manager.handleInput("h");
		manager.handleInput("\x1b[B");
		manager.handleInput("b");
		expect(runtime.calls.slice(1)).toEqual([`flags a {"hidden":true}`, `flags b {"blocked":true}`]);
		manager.dispose();
	});

	test("m cycles the mode", () => {
		const { manager, runtime } = mount({ ...baseState(), mode: "local", hasKey: false });
		manager.handleInput("m");
		manager.handleInput("m");
		manager.handleInput("m");
		expect(runtime.calls).toEqual(["mode=remote", "mode=both", "mode=local"]);
		manager.dispose();
	});

	test("compose sends the chosen kind to the selected peer", async () => {
		const { manager, runtime } = mount({ ...baseState(), approvals: [] });
		manager.handleInput("c");
		manager.handleInput("\x1b[C"); // → ask
		manager.handleInput("\r");
		typeText(manager, "hi there");
		manager.handleInput("\r");
		await runtime.pending;
		expect(runtime.calls).toEqual(["send a ask hi there"]);
		manager.dispose();
	});

	test("compose to a blocked peer only sends notes", async () => {
		const state = { ...baseState(), approvals: [], peers: [peer({ instanceId: "x", blocked: true })] };
		const { manager, runtime } = mount(state);
		manager.handleInput("c");
		manager.handleInput("1"); // status: refused, the kind picker stays
		typeText(manager, "nope");
		manager.handleInput("4"); // note
		typeText(manager, "fyi");
		manager.handleInput("\r");
		await runtime.pending;
		expect(runtime.calls).toEqual(["send x note fyi"]);
		manager.dispose();
	});

	test("key phrase must be entered twice; a mismatch derives nothing", async () => {
		const { manager, runtime } = mount(baseState());
		manager.handleInput("k");
		typeText(manager, "correct horse battery");
		manager.handleInput("\r");
		typeText(manager, "correct horse batterx");
		manager.handleInput("\r");
		expect(runtime.calls).toEqual([]);
		// Back at the first step after a mismatch.
		typeText(manager, "correct horse battery");
		manager.handleInput("\r");
		typeText(manager, "correct horse battery");
		const masked = manager.render(100).join("\n");
		expect(masked).not.toContain("correct horse");
		manager.handleInput("\r");
		await runtime.pending;
		expect(runtime.calls).toEqual(["key=correct horse battery"]);
		manager.dispose();
	});

	test("escape closes; runtime changes re-render live and dispose unsubscribes", async () => {
		vi.useFakeTimers();
		try {
			const { manager, runtime, closed } = mount({ ...baseState(), approvals: [] });
			runtime.state = { ...runtime.state, peers: [peer({ instanceId: "0" })] };
			for (const listener of runtime.listeners) listener();
			manager.handleInput("c");
			manager.handleInput("4");
			typeText(manager, "x");
			manager.handleInput("\r");
			// Before the coalesced pull the selection still resolves against the old peers.
			expect(runtime.calls).toEqual(["send a note x"]);
			await runtime.pending;
			vi.advanceTimersByTime(150);
			manager.handleInput("c");
			manager.handleInput("4");
			typeText(manager, "y");
			manager.handleInput("\r");
			expect(runtime.calls).toEqual(["send a note x", "send 0 note y"]);
			await runtime.pending;
			manager.handleInput("\x1b");
			expect(closed()).toBe(true);
			expect(runtime.listeners.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("mesh manager on Tern", () => {
	test("details open in the preview; the close action backs out of them before closing", () => {
		const { manager, closed } = mount({ ...baseState(), mode: "local" });
		const list = pickerProps(manager);
		expect(list.order).toContainEqual(expect.objectContaining({ group: "remote" }));
		// The side the mode does not reach shows a disabled row that selects nothing.
		expect(list.items?.find(item => item.id === "off:remote")?.disabled).toBeTruthy();
		manager.handleNativeEvent({ type: "select", key: "", item: "off:remote" });
		expect(pickerProps(manager).selected).toBe("approval:ap1");

		manager.handleNativeEvent({ type: "activate", key: "", item: "peer:b" });
		const details = pickerProps(manager);
		expect(details).toMatchObject({ selected: "peer:b", focus: "preview" });
		expect(details.actions?.at(-1)).toMatchObject({ id: "close", label: "Back" });

		act(manager, "close");
		expect(pickerProps(manager).focus).toBe("list");
		expect(closed()).toBe(false);
		act(manager, "close");
		expect(closed()).toBe(true);
	});

	test("Approve never resolves an approval the user has not seen selected", async () => {
		vi.useFakeTimers();
		try {
			const { manager, runtime } = mount(baseState());
			expect(pickerProps(manager).selected).toBe("approval:ap1");
			// The selected request goes away and a newer one takes the first row before the next frame.
			const newer = { ...runtime.state.approvals[0]!, id: "ap0", kind: "task", fromName: "mallory" };
			runtime.state = { ...runtime.state, approvals: [newer] };
			for (const listener of runtime.listeners) listener();
			vi.advanceTimersByTime(150);
			act(manager, "a");
			expect(runtime.calls).toEqual([]);
			// Activating a row only selects it; Approve then resolves exactly that row.
			manager.handleNativeEvent({ type: "activate", key: "", item: "approval:ap0" });
			expect(runtime.calls).toEqual([]);
			act(manager, "a");
			expect(runtime.calls).toEqual(["approval ap0 true"]);
			manager.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("compose picks a kind on the strip, then sends from an input card", async () => {
		const { manager, runtime } = mount({ ...baseState(), approvals: [] });
		act(manager, "c");
		const strip = pickerProps(manager);
		expect(strip.focus).toBe("strip");
		expect(strip.strip?.items.map(item => item.label)).toEqual(["status", "ask", "steer", "note"]);

		act(manager, "strip", "1");
		expect(manager.nativeSheet(pickerCx)).toBe(false);
		expect(manager.nativeOverlay).toMatchObject({ role: "omp.overlay.mesh" });
		typeText(manager, "what is 4*4?");
		const card = nodes(manager.describe(pickerCx));
		expect(card.find(entry => entry.k === "input")?.p).toMatchObject({ text: "what is 4*4?" });
		act(manager, "submit");
		await runtime.pending;
		expect(runtime.calls).toEqual(["send a ask what is 4*4?"]);
		expect(manager.nativeSheet(pickerCx)).toBe(true);
		manager.dispose();
	});

	test("the key phrase never reaches the described tree", async () => {
		const { manager, runtime } = mount(baseState());
		act(manager, "k");
		typeText(manager, "correct horse battery");
		act(manager, "submit");
		typeText(manager, "correct horse battery");
		const described = JSON.stringify(nodes(manager.describe(pickerCx)));
		expect(described).not.toContain("correct horse");
		expect(described).toContain("•".repeat(21));
		act(manager, "submit");
		await runtime.pending;
		expect(runtime.calls).toEqual(["key=correct horse battery"]);
		manager.dispose();
	});

	test("a terminal without pickers keeps the rendered page, prompts included", () => {
		const { manager } = mount(baseState());
		expect(manager.nativeSheet(withoutPicker)).toBe(false);
		expect(manager.describe(withoutPicker)).toBeNull();
		act(manager, "k");
		expect(manager.nativeSheet(withoutPicker)).toBe(false);
		expect(manager.nativeOverlay).toBeUndefined();
		expect(manager.describe(withoutPicker)).toBeNull();
		manager.dispose();
	});
});
