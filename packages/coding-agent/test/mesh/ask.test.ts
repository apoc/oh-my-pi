import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { MeshPeerView } from "../../src/mesh/engine";
import type { MeshFrontend } from "../../src/mesh/inbound";
import { MeshOutbound } from "../../src/mesh/outbound";
import { type MeshRuntime, setMeshRuntime } from "../../src/mesh/runtime";
import type { MeshSnapshot } from "../../src/mesh/wire";
import { createTuiMeshUiHooks } from "../../src/modes/components/mesh/mesh-ui-hooks";
import { MeshAskController } from "../../src/modes/controllers/mesh-ask-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import { buildMeshPeerArgumentCompletions } from "../../src/slash-commands/builtin-completions";
import { buildTuiBuiltinSlashCommands, executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { Settings } from "../../src/config/settings";
import { cfgMeshEnabled } from "../../src/mesh/settings";
import { ScriptedMeshEngine } from "./scripted-engine";

function peer(instanceId: string, displayName: string, sessionName: string | null, hidden = false): MeshPeerView {
	const snapshot: MeshSnapshot = {
		instanceId,
		displayName,
		host: "box",
		pid: 1,
		ompVersion: "0.0.0",
		protocol: 1,
		sessionId: null,
		sessionName,
		summary: null,
		cwd: "/work",
		repo: { branch: "main" },
		model: null,
		busy: false,
		agents: [],
		startedAt: 0,
	};
	return {
		instanceId,
		endpoint: { kind: "local" },
		source: "local",
		state: "online",
		lastSeen: Date.now(),
		hidden,
		blocked: false,
		snapshot,
	};
}

const PEERS = [
	peer("b93faeff1b87b3c5", "ApoC@SHARK", "ARBTR: knowledge arbiter"),
	peer("c0ffee00c0ffee00", "Carol", null),
	peer("d00dd00dd00dd00d", "Dave", "secret", true),
];

beforeAll(async () => {
	await initTheme();
});

afterEach(() => setMeshRuntime(undefined));

describe("/ask agent whisper", () => {
	it("shows listed peers by session name and inserts the instance id", () => {
		const complete = buildMeshPeerArgumentCompletions(() => PEERS.filter(entry => !entry.hidden));
		expect(complete("")).toEqual([
			{
				value: "b93faeff1b87b3c5 ",
				label: "ARBTR: knowledge arbiter",
				description: "ApoC@SHARK · b93faeff · idle · main",
			},
			{ value: "c0ffee00c0ffee00 ", label: "Carol", description: "Carol · c0ffee00 · idle · main" },
		]);
	});

	it("matches session names, display names and ids, and stops at the message", () => {
		const complete = buildMeshPeerArgumentCompletions(() => PEERS);
		expect(complete("arbiter")?.map(item => item.value)).toEqual(["b93faeff1b87b3c5 "]);
		expect(complete("CAR")?.map(item => item.value)).toEqual(["c0ffee00c0ffee00 "]);
		expect(complete("b93f")?.map(item => item.value)).toEqual(["b93faeff1b87b3c5 "]);
		expect(complete("nobody")).toBeNull();
		expect(complete("b93faeff1b87b3c5 hello")).toBeNull();
	});
});

describe("/ask availability", () => {
	it("exists only while mesh.enabled is on: hidden and not run when typed, following the setting live", async () => {
		const settings = Settings.isolated({});
		const asked: string[] = [];
		const ctx = {
			settings,
			editor: { clearDraft: () => {} },
			handleMeshAskCommand: async (args: string) => {
				asked.push(args.trim());
				return true;
			},
		} as unknown as InteractiveModeContext;
		const ask = buildTuiBuiltinSlashCommands({ ctx }).find(command => command.name === "ask");
		expect(ask?.isHidden?.()).toBe(true);
		expect(await executeBuiltinSlashCommand("/ask carol hi", { ctx })).toBe(false);
		expect(asked).toEqual([]);

		cfgMeshEnabled.set(settings, true);
		expect(ask?.isHidden?.()).toBe(false);
		expect(await executeBuiltinSlashCommand("/ask carol hi", { ctx })).toBe(true);
		expect(asked).toEqual(["carol hi"]);
	});
});

/** Renders the dialog panel shown by the controller; records what reached the transcript. */
function harness(peers: MeshPeerView[] = PEERS) {
	const engine = new ScriptedMeshEngine(peers);
	const cards: Component[] = [];
	const errors: string[] = [];
	let overlay: (Component & { handleInput?(data: string): void }) | undefined;
	const ctx = {
		present: (card: Component) => cards.push(card),
		toolOutputExpanded: false,
		showStatus: () => {},
		showError: (message: string) => errors.push(message),
		keybindings: { getKeys: () => [] },
		dictationSpaceHold: () => undefined,
		ui: {
			nativeRendering: false,
			terminal: { rows: 40 },
			requestRender: () => {},
			setFocus: () => {},
			showOverlay: (component: Component) => {
				overlay = component;
				return { hide: () => (overlay = undefined) };
			},
		},
	} as unknown as InteractiveModeContext;
	const controller = new MeshAskController(ctx);
	const outbound = new MeshOutbound({
		engine,
		main: { isDisposed: false, conversationId: "c1", sendCustomMessage: async () => false },
		ui: createTuiMeshUiHooks(ctx),
	});
	setMeshRuntime({ engine, frontend: { outbound } as unknown as MeshFrontend } as unknown as MeshRuntime);
	const screen = () => overlay?.render(120).join("\n") ?? "";
	const type = (text: string) => {
		for (const char of text) overlay?.handleInput?.(char);
	};
	return { engine, outbound, cards, errors, controller, screen, type, overlay: () => overlay };
}

const ARBITER = { instanceId: "b93faeff1b87b3c5", agentId: "Main", displayName: "ApoC@SHARK", host: "box" };

/** Drain microtasks until `check` holds: every hop here is promise-driven, no clock involved. */
async function until(check: () => boolean): Promise<void> {
	for (let hop = 0; hop < 200 && !check(); hop++) await Promise.resolve();
	expect(check()).toBe(true);
}

describe("/ask conversations", () => {
	it("/ask <peer> <message> opens the dialog on the new thread and shows the answer there", async () => {
		const h = harness();
		expect(await h.controller.handleCommand("b93faeff1b87b3c5 what is ARBTR?")).toBe(true);
		expect(h.engine.sent[0]?.body).toEqual({ op: "message", kind: "ask", text: "what is ARBTR?" });
		expect(h.screen()).toContain("what is ARBTR?");
		h.engine.answer("msg-1", {
			op: "reply",
			replyTo: "msg-1",
			thread: "thread-1",
			text: "a fact checker",
			from: ARBITER,
		});
		await until(() => h.screen().includes("a fact checker"));
		expect(h.screen()).not.toContain("Waiting for the agent");
		expect(h.cards).toHaveLength(0);
	});

	it("keeps an answer that overtakes its acknowledgement in the opened dialog", async () => {
		const h = harness();
		// The engine holds an answer that overtook its acknowledgement for the dialog's wait.
		h.engine.respond = request => {
			const msgId = `msg-${h.engine.sent.length}`;
			h.engine.answer(msgId, { op: "reply", replyTo: msgId, thread: "thread-1", text: "fast", from: ARBITER });
			return h.engine.defaultResponse(request);
		};
		expect(await h.controller.handleCommand("b93faeff1b87b3c5 quick?")).toBe(true);
		await until(() => h.screen().includes("fast"));
		expect(h.screen()).not.toContain("Waiting for the agent");
	});

	it("continues the thread on follow-up and shows the waited answer only in the dialog", async () => {
		const h = harness();
		h.engine.respond = request => {
			const { body } = request;
			if (body.op === "message") {
				const msgId = `msg-${h.engine.sent.length}`;
				h.engine.answer(msgId, {
					op: "reply",
					replyTo: msgId,
					thread: "thread-1",
					text: `answer to ${body.text}`,
					from: ARBITER,
				});
			}
			return h.engine.defaultResponse(request);
		};
		expect(await h.controller.handleCommand("b93faeff1b87b3c5")).toBe(true);
		// No conversation yet: the dialog opens on a new-question composer.
		h.type("first?");
		h.overlay()?.handleInput?.("\r");
		await until(() => h.screen().includes("answer to first?"));

		h.overlay()?.handleInput?.("f");
		h.type("second?");
		h.overlay()?.handleInput?.("\r");
		await until(() => h.screen().includes("answer to second?"));
		expect(h.engine.sent[1]?.body).toEqual({ op: "message", kind: "ask", text: "second?", thread: "thread-1" });
		expect(h.screen()).not.toContain("Waiting for the agent");
		expect(h.cards).toHaveLength(0);
		expect(h.errors).toEqual([]);
	});

	it("folds an answer that outlived the wait into its turn and still shows its card", async () => {
		const h = harness();
		expect(await h.controller.handleCommand("b93faeff1b87b3c5 slow?")).toBe(true);
		// Escape on the running turn stops waiting; the dialog stays open.
		h.overlay()?.handleInput?.("\x1b");
		await until(() => h.screen().includes("Stopped waiting"));
		h.engine.late("msg-1", { op: "reply", replyTo: "msg-1", thread: "thread-1", text: "late fact", from: ARBITER });
		await until(() => h.screen().includes("late fact"));
		expect(h.screen()).not.toContain("Stopped waiting");
		expect(h.cards).toHaveLength(1);
	});

	it("refuses a blocked peer without sending and keeps the draft", async () => {
		const h = harness([{ ...PEERS[0]!, blocked: true }]);
		expect(await h.controller.handleCommand("b93faeff1b87b3c5 hello?")).toBe(false);
		expect(h.engine.sent).toHaveLength(0);
		expect(h.errors).toHaveLength(1);
		expect(h.errors[0]).toContain("is blocked");
	});
});
