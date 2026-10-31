import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	MeshSummaryGenerator,
	type MeshSummaryState,
	SUMMARY_MIN_INTERVAL_MS,
	type SummaryTriggerState,
	shouldRegenerateSummary,
} from "@oh-my-pi/pi-coding-agent/mesh/summary";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { TempDir } from "@oh-my-pi/pi-utils";

const T0 = 1_700_000_000_000;
const RESET: SummaryTriggerState = { lastAttemptAt: null, summarizedUserTurnAt: null, latestUserTurnAt: null };

describe("shouldRegenerateSummary", () => {
	it("waits for the operator's first turn", () => {
		expect(shouldRegenerateSummary(RESET, T0)).toBe(false);
	});

	it("summarizes right after the first completed turn", () => {
		expect(shouldRegenerateSummary({ ...RESET, latestUserTurnAt: T0 }, T0 + 1)).toBe(true);
	});

	it("holds a new turn until the interval since the last attempt elapses", () => {
		const state: SummaryTriggerState = {
			lastAttemptAt: T0,
			summarizedUserTurnAt: T0 - 10,
			latestUserTurnAt: T0 + 30_000,
		};
		expect(shouldRegenerateSummary(state, T0 + SUMMARY_MIN_INTERVAL_MS - 1)).toBe(false);
		expect(shouldRegenerateSummary(state, T0 + SUMMARY_MIN_INTERVAL_MS)).toBe(true);
	});

	it("skips when no user turn arrived since the covered one, however long ago", () => {
		const state: SummaryTriggerState = {
			lastAttemptAt: T0,
			summarizedUserTurnAt: T0 - 10,
			latestUserTurnAt: T0 - 10,
		};
		expect(shouldRegenerateSummary(state, T0 + 10 * SUMMARY_MIN_INTERVAL_MS)).toBe(false);
	});

	it("retries a failed first attempt only after the interval", () => {
		const state: SummaryTriggerState = { lastAttemptAt: T0, summarizedUserTurnAt: null, latestUserTurnAt: T0 - 10 };
		expect(shouldRegenerateSummary(state, T0 + 1000)).toBe(false);
		expect(shouldRegenerateSummary(state, T0 + SUMMARY_MIN_INTERVAL_MS)).toBe(true);
	});
});

const model = getBundledModel("anthropic", "claude-haiku-4-5");
if (!model) throw new Error("Expected bundled claude-haiku-4-5");

function reply(text: string): ai.AssistantMessage {
	return {
		stopReason: "stop",
		content: [{ type: "text", text }],
		usage: { cost: { total: 0.01 } },
	} as never;
}

/** The slice of AgentSession the generator reads, driven by the test. */
class FakeSession {
	readonly settings = Settings.isolated({ "mesh.enabled": true, "mesh.summary": true });
	readonly model = model;
	readonly modelRegistry = {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
		authStorage: { oauth: { accounts: () => [], identity: () => undefined }, sessions: { pin: () => {} } },
	};
	readonly sessionId = "provider-session";
	readonly isDisposed = false;
	readonly isStreaming = false;
	readonly obfuscator = undefined;
	spent = 0;
	readonly costGate = { check: () => undefined, record: (cost: number) => (this.spent += cost) };
	messages: AgentMessage[] = [];
	#id: string;
	#artifactsDir: string;
	readonly sessionManager = {
		getSessionId: () => this.#id,
		getSessionName: () => undefined,
		getCwd: () => this.#artifactsDir,
		getArtifactsDir: () => this.#artifactsDir,
	};
	#listeners = new Set<AgentSessionEventListener>();
	#changeCallbacks = new Set<() => void>();

	constructor(id: string, artifactsDir: string) {
		this.#id = id;
		this.#artifactsDir = artifactsDir;
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	registerSessionChangeCallback(callback: () => void): () => void {
		this.#changeCallbacks.add(callback);
		return () => this.#changeCallbacks.delete(callback);
	}

	getTodoPhases() {
		return [];
	}

	userTurn(text: string, timestamp: number): void {
		this.messages.push({ role: "user", content: text, attribution: "user", timestamp } as AgentMessage);
		for (const listener of this.#listeners) listener({ type: "agent_end", messages: [], isTerminal: true });
	}

	switchTo(id: string, artifactsDir: string): void {
		this.#id = id;
		this.#artifactsDir = artifactsDir;
		this.messages = [];
		for (const callback of this.#changeCallbacks) callback();
	}

	get asSession(): AgentSession {
		return this as unknown as AgentSession;
	}
}

function nextSummary(generator: MeshSummaryGenerator): Promise<MeshSummaryState | null> {
	const { promise, resolve } = Promise.withResolvers<MeshSummaryState | null>();
	const off = generator.onChange(summary => {
		if (!summary) return;
		off();
		resolve(summary);
	});
	return promise;
}

describe("MeshSummaryGenerator", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-mesh-summary-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("drops a generation that finishes after a session switch", async () => {
		const pending = Promise.withResolvers<ai.AssistantMessage>();
		const started = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			started.resolve();
			return pending.promise as never;
		});
		const session = new FakeSession("session-a", tempDir.join("a"));
		const generator = new MeshSummaryGenerator();
		const published: (MeshSummaryState | null)[] = [];
		generator.onChange(summary => published.push(summary));
		const detach = generator.attach(session.asSession);

		session.userTurn("Fix the retry queue dropping jobs", Date.now());
		await started.promise;
		session.switchTo("session-b", tempDir.join("b"));
		pending.resolve(reply("Fixing the retry queue."));
		await generator.settled();

		expect(generator.current).toBeNull();
		expect(published.filter(summary => summary !== null)).toEqual([]);
		expect(await Bun.file(tempDir.join("a", "mesh-summary.json")).exists()).toBe(false);
		detach();
	});

	it("loads only its own session's persisted summary", async () => {
		const persisted = (sessionId: string, text: string) =>
			JSON.stringify({ v: 1, sessionId, text, updatedAt: T0, userTurnAt: T0 });
		await fs.mkdir(tempDir.join("own"), { recursive: true });
		await fs.mkdir(tempDir.join("foreign"), { recursive: true });
		await Bun.write(tempDir.join("own", "mesh-summary.json"), persisted("own", "Own summary."));
		await Bun.write(tempDir.join("foreign", "mesh-summary.json"), persisted("someone-else", "Leaked summary."));
		const foreign = new MeshSummaryGenerator();
		const own = new MeshSummaryGenerator();
		const foreignChanges: (MeshSummaryState | null)[] = [];
		foreign.onChange(summary => foreignChanges.push(summary));
		const ownLoaded = nextSummary(own);
		const detachForeign = foreign.attach(new FakeSession("foreign", tempDir.join("foreign")).asSession);
		const detachOwn = own.attach(new FakeSession("own", tempDir.join("own")).asSession);

		expect(await ownLoaded).toEqual({ text: "Own summary.", updatedAt: T0 });
		await foreign.settled();
		expect(foreign.current).toBeNull();
		expect(foreignChanges).toEqual([]);
		detachForeign();
		detachOwn();
	});

	it("summarizes a turn that settled while the previous summary was generating", async () => {
		const first = Promise.withResolvers<ai.AssistantMessage>();
		const firstStarted = Promise.withResolvers<void>();
		const completeSimple = vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			if (completeSimple.mock.calls.length === 1) {
				firstStarted.resolve();
				return first.promise as never;
			}
			return reply("Adding jitter to retry backoff.") as never;
		});
		const session = new FakeSession("session-a", tempDir.join("a"));
		const generator = new MeshSummaryGenerator({ minIntervalMs: 0 });
		const detach = generator.attach(session.asSession);

		session.userTurn("Fix the retry queue dropping jobs", Date.now());
		await firstStarted.promise;
		session.userTurn("Now add jitter to the backoff", Date.now() + 1);
		const firstSummary = nextSummary(generator);
		first.resolve(reply("Fixing the retry queue."));
		expect((await firstSummary)?.text).toBe("Fixing the retry queue.");

		const secondSummary = await nextSummary(generator);
		expect(secondSummary?.text).toBe("Adding jitter to retry backoff.");
		expect(completeSimple).toHaveBeenCalledTimes(2);
		const secondInput = JSON.stringify(completeSimple.mock.calls[1]?.[1].messages);
		expect(secondInput).toContain("Now add jitter to the backoff");
		expect(session.spent).toBeCloseTo(0.02);
		detach();
	});
});
