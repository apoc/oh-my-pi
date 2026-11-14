import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { corpusEnvironment, describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { MESH_INCOMING_MESSAGE_TYPE } from "../../../../src/mesh/bridge";
import type { MeshSender } from "../../../../src/mesh/wire";
import { createTuiMeshUiHooks } from "../../../../src/modes/components/mesh/mesh-ui-hooks";
import { UiHelpers } from "../../../../src/modes/utils/ui-helpers";
import type { CustomMessage } from "../../../../src/session/transcript/messages";
import { createInteractiveModeContext, renderTranscript } from "../../../helpers/interactive-mode-context";

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
		const { ctx, helpers, rows } = context();
		const sender = { instanceId: "i", agentId: "Main", displayName: `Eve${HOSTILE}`, host: `h${HOSTILE}` };
		const [block] = helpers.addMessageToChat(
			incoming({ kind: `k${HOSTILE}`, from: sender, message: `body ${HOSTILE}` }),
		);
		if (!block) throw new Error("the steer drew no block");
		// The native card carries the same text: it must be clean in the tree, not only on screen.
		const tree = JSON.stringify(describeTree(block.node, corpusEnvironment("dark"), 120));
		expect(tree).not.toContain("\\u001b");
		expect(tree).not.toContain("\u202e");
		expect(tree).not.toContain("pwned");
		createTuiMeshUiHooks(ctx).showIncoming(sender, { kind: "note", text: `live ${HOSTILE}`, thread: `t${HOSTILE}` });
		const text = rows().join("\n");
		expect(text).toContain("body red");
		expect(text).toContain("live red");
		expect(text).not.toContain("\x1b");
		expect(text).not.toContain("\u202e");
		expect(text).not.toContain("pwned");
	});
});
