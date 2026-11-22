import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { corpusEnvironment, describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { MESH_INCOMING_MESSAGE_TYPE } from "../../../../src/mesh/bridge";
import type { MeshSender } from "../../../../src/mesh/wire";
import { createTuiMeshUiHooks } from "../../../../src/modes/components/mesh/mesh-ui-hooks";
import { UiHelpers } from "../../../../src/modes/utils/ui-helpers";
import type { CustomMessage } from "../../../../src/session/transcript/messages";
import type { TranscriptBlock } from "../../../../src/ui/shell";
import { createInteractiveModeContext, renderTranscript } from "../../../helpers/interactive-mode-context";

interface Described {
	k: string;
	p?: { text?: string };
	c?: Described[];
}

function collect(node: Described, out: Described[] = []): Described[] {
	out.push(node);
	for (const child of node.c ?? []) collect(child, out);
	return out;
}

/** A peer-supplied Markdown link: on a mesh card it must stay inert text. */
const LINK_BODY = "see [docs](https://evil.example) now";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const PEER: MeshSender = { instanceId: "b93faeff1b87b3c5", agentId: "Main", displayName: "Carol", host: "box" };
/** Terminal escapes and a bidi override an untrusted peer could smuggle into its text. */
const HOSTILE = "\x1b[31mred\x1b[0m\u202eevil\x1b]0;pwned\x07";

function context() {
	const ctx = createInteractiveModeContext({ settings: Settings.isolated() });
	const helpers = new UiHelpers(ctx);
	return { ctx, helpers, rows: () => renderTranscript(ctx) };
}

function incoming(details: object, timestamp = 1): CustomMessage {
	return {
		role: "custom",
		customType: MESH_INCOMING_MESSAGE_TYPE,
		content: "envelope the model reads",
		details,
		display: true,
		timestamp,
	};
}

describe("mesh transcript cards", () => {
	it("rebuilds a persisted mesh:incoming steer as a `MESH ← peer` card with its kind and body", () => {
		const { helpers, rows } = context();
		const [block] = helpers.addMessageToChat(incoming({ kind: "steer", from: PEER, message: "please rebase" }));
		if (!block) throw new Error("the steer drew no block");
		const tree = JSON.stringify(describeTree(block.node, corpusEnvironment("dark"), 120));
		expect(tree).toContain('"role":"omp.mesh.incoming"');
		const text = rows().join("\n");
		expect(text).toContain("MESH");
		expect(text).toContain("Carol@box");
		expect(text).toContain("steer");
		expect(text).toContain("please rebase");
		expect(text).not.toContain("envelope the model reads");
		expect(text).not.toContain("IRC");
	});

	it("shows live incoming and outgoing traffic with its thread and error tags", () => {
		const { ctx, rows } = context();
		const hooks = createTuiMeshUiHooks(ctx);
		hooks.showIncoming(PEER, { kind: "ask", text: "what is ARBTR?", thread: "t-1" });
		hooks.showOutgoing(PEER, { kind: "reply", text: "refused", thread: "t-1", error: true });
		const [first, second] = rows().filter(row => row.includes("MESH"));
		expect(first).toMatch(/MESH \S+ Carol@box/);
		expect(first).toContain("ask");
		expect(first).toContain("thread t-1");
		expect(first).not.toContain("error");
		expect(second).toContain("reply");
		expect(second).toContain("error");
		// Incoming and outgoing differ by their direction glyph.
		expect(first?.match(/MESH (\S+)/)?.[1]).not.toBe(second?.match(/MESH (\S+)/)?.[1]);
		expect(rows().join("\n")).toContain("what is ARBTR?");
	});

	it("falls back to the instance id, then `?`, when a peer declares no name", () => {
		const { helpers, rows } = context();
		helpers.addMessageToChat(incoming({ from: { instanceId: "c0ffee00c0ffee00" }, message: "one" }));
		helpers.addMessageToChat(incoming({ message: "two" }, 2));
		const text = rows().join("\n");
		expect(text).toMatch(/MESH \S+ c0ffee00c0ffee00/);
		expect(text).toMatch(/MESH \S+ \?/);
		// A steer with no declared kind is a steer.
		expect(text).toContain("steer");
	});

	it("strips terminal escapes and bidi controls from every peer string, rebuilt and live", () => {
		const { ctx, helpers } = context();
		const sender = { instanceId: "i", agentId: "Main", displayName: `Eve${HOSTILE}`, host: `h${HOSTILE}` };
		const nativeTree = (block: TranscriptBlock) =>
			JSON.stringify(describeTree(block.node, corpusEnvironment("dark"), 120));
		const [rebuilt] = helpers.addMessageToChat(
			incoming({ kind: `k${HOSTILE}`, from: sender, message: `body ${HOSTILE}` }),
		);
		if (!rebuilt) throw new Error("the steer drew no block");
		createTuiMeshUiHooks(ctx).showIncoming(sender, { kind: "note", text: `live ${HOSTILE}`, thread: `t${HOSTILE}` });
		const live = ctx.shell.transcript.blocks().at(-1);
		if (!live || live === rebuilt) throw new Error("the live card drew no block");
		// The native card carries the peer's text: it must be clean in the tree itself.
		for (const [tree, body] of [
			[nativeTree(rebuilt), "body red"],
			[nativeTree(live), "live red"],
		] as const) {
			expect(tree).toContain(body);
			expect(tree).not.toContain("\\u001b");
			expect(tree).not.toContain("\u202e");
			expect(tree).not.toContain("pwned");
		}
		// The thread tag is peer text too.
		expect(nativeTree(live)).toContain("thread tred");
	});

	it("renders peer text as plain text, with no markdown or link node", () => {
		const { helpers } = context();
		const [block] = helpers.addMessageToChat(incoming({ kind: "note", from: PEER, message: LINK_BODY }));
		if (!block) throw new Error("the note drew no block");
		const all = collect(describeTree(block.node, corpusEnvironment("dark"), 120) as Described);
		expect(all.some(node => node.k === "md")).toBe(false);
		expect(all.some(node => node.k === "text" && node.p?.text === LINK_BODY)).toBe(true);
	});

	it("keeps markdown on IRC cards", () => {
		const { helpers } = context();
		const [block] = helpers.addMessageToChat({
			role: "custom",
			customType: "irc:incoming",
			content: LINK_BODY,
			details: { from: "Peer", message: LINK_BODY },
			display: true,
			timestamp: 1,
		});
		if (!block) throw new Error("the IRC message drew no block");
		const all = collect(describeTree(block.node, corpusEnvironment("dark"), 120) as Described);
		expect(all.find(node => node.k === "md")?.p?.text).toBe(LINK_BODY);
	});
});
