/**
 * A confined fork (a mesh `ask` responder) reads `agent://` only within its
 * source session's artifacts: no globally registered agent (other responder
 * threads included) and no other omp instance.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function liveSession(answer: string): AgentSession {
	return {
		messages: [{ role: "assistant", content: [{ type: "text", text: answer }], timestamp: 1 }],
	} as unknown as AgentSession;
}

function toolSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "agent-read", path: path.join(cwd, "artifacts", "agent-read.log") }),
		settings: Settings.isolated({ "task.crossInstance": true }),
		...overrides,
	};
}

interface Fixture {
	sourceArtifacts: string;
	fork: { session: ToolSession; sessionFile: string };
	ordinary: { session: ToolSession; sessionFile: string };
}

async function setup(dir: string): Promise<Fixture> {
	const cwd = path.join(dir, "project");
	const sourceArtifacts = path.join(dir, "source");
	await Bun.write(path.join(sourceArtifacts, "Worker.md"), "source worker output\n");
	// Another peer's responder thread: registered globally, outside the source.
	AgentRegistry.global().register({
		id: "MeshAsk",
		displayName: "mesh ask",
		kind: "sub",
		session: liveSession("peer A secret answer"),
		status: "running",
	});
	const external = path.join(dir, "external");
	await Bun.write(path.join(external, "ExternalOnly.md"), "external output\n");
	registerArtifactsDir(external);
	return {
		sourceArtifacts,
		fork: {
			session: toolSession(cwd, { forkSource: `${sourceArtifacts}.jsonl` }),
			sessionFile: path.join(dir, "forks", "Fork.jsonl"),
		},
		ordinary: { session: toolSession(cwd), sessionFile: path.join(dir, "main.jsonl") },
	};
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	return promise.then(
		() => "resolved",
		(err: unknown) => (err instanceof Error ? err.message : String(err)),
	);
}

describe("agent:// in a confined fork", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("reads its source's outputs", async () => {
		using tempDir = TempDir.createSync("@omp-agent-fork-");
		const { sourceArtifacts, fork } = await setup(tempDir.path());
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("agent://Worker", fork);
		expect(resource.content).toBe("source worker output\n");
		expect(await router.locate("agent://Worker", fork)).toBe(path.join(sourceArtifacts, "Worker.md"));
	});

	it("cannot read a globally registered agent outside its source; an ordinary session can", async () => {
		using tempDir = TempDir.createSync("@omp-agent-fork-");
		const { fork, ordinary } = await setup(tempDir.path());
		const router = InternalUrlRouter.instance();

		const visible = await router.resolve("agent://MeshAsk", ordinary);
		expect(visible.content).toContain("peer A secret answer");

		const message = await rejection(router.resolve("agent://MeshAsk", fork));
		expect(message).toStartWith("Not found: MeshAsk");
		expect(message).not.toContain("peer A secret answer");
	});

	it("lists no registered ids or foreign outputs in a not-found error or completion", async () => {
		using tempDir = TempDir.createSync("@omp-agent-fork-");
		const { fork, ordinary } = await setup(tempDir.path());
		const router = InternalUrlRouter.instance();

		expect(await rejection(router.resolve("agent://Mesh", ordinary))).toContain("MeshAsk");
		const message = await rejection(router.resolve("agent://Mesh", fork));
		expect(message).toStartWith("Not found: Mesh");
		expect(message).not.toContain("MeshAsk");

		const handler = router.getHandler("agent");
		const forkIds = (await handler?.complete?.("", fork))?.map(item => item.value);
		expect(forkIds).toEqual(["Worker"]);
		const ordinaryIds = (await handler?.complete?.("", ordinary))?.map(item => item.value);
		expect(ordinaryIds).toContain("ExternalOnly");
	});

	it("refuses agent://peers and agent://<pid> even with task.crossInstance on", async () => {
		using tempDir = TempDir.createSync("@omp-agent-fork-");
		const { fork, ordinary } = await setup(tempDir.path());
		const router = InternalUrlRouter.instance();

		const peers = await router.resolve("agent://peers", ordinary);
		expect(peers.content).toContain("No other omp instances in this project");
		expect(await rejection(router.resolve("agent://peers", fork))).toStartWith("Not found: peers");

		const otherPid = process.pid + 100_000;
		expect(await rejection(router.resolve(`agent://${otherPid}/Worker`, ordinary))).toStartWith(
			`No live omp instance with pid ${otherPid}`,
		);
		expect(await rejection(router.resolve(`agent://${otherPid}/Worker`, fork))).toStartWith(`Not found: ${otherPid}`);
		// This process's own pid reads as a local address only outside a fork.
		expect(await rejection(router.resolve(`agent://${process.pid}/Worker`, fork))).toStartWith(
			`Not found: ${process.pid}`,
		);
	});

	it("reads its own scouts' outputs, which its task results link to", async () => {
		using tempDir = TempDir.createSync("@omp-agent-fork-");
		const { fork } = await setup(tempDir.path());
		const ownArtifacts = fork.session.getArtifactsDir?.();
		if (!ownArtifacts) throw new Error("fixture has no artifacts dir");
		await Bun.write(path.join(ownArtifacts, "0-Scout.md"), "scout report\n");
		const router = InternalUrlRouter.instance();

		expect((await router.resolve("agent://0-Scout", fork)).content).toBe("scout report\n");
	});

	it("stays confined when its fork source yields no artifacts dir", async () => {
		using tempDir = TempDir.createSync("@omp-agent-fork-");
		const { ordinary } = await setup(tempDir.path());
		const fork = {
			session: toolSession(path.join(tempDir.path(), "project"), {
				forkSource: path.join(tempDir.path(), "not-a-session.txt"),
			}),
		};
		const router = InternalUrlRouter.instance();

		expect((await router.resolve("agent://ExternalOnly", ordinary)).content).toBe("external output\n");
		// Only the fork's own (absent) artifacts dir is scanned: no registered dir, no registry agent.
		expect(await rejection(router.resolve("agent://ExternalOnly", fork))).toBe("No artifacts directory found");
		expect(await rejection(router.resolve("agent://MeshAsk", fork))).toBe("No artifacts directory found");
	});
});

describe("proc:// in a confined fork", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("lists only the fork's own scouts, never other sessions' running agents", async () => {
		using tempDir = TempDir.createSync("@omp-proc-fork-");
		const cwd = path.join(tempDir.path(), "project");
		const registry = AgentRegistry.global();
		registry.register({
			id: "MeshAsk",
			displayName: "mesh ask",
			kind: "sub",
			session: liveSession("peer A"),
			status: "running",
			activity: "Reading peer-A-secret-plan.md",
		});
		registry.register({
			id: "0-Scout",
			displayName: "scout",
			kind: "sub",
			parentId: "MeshAskFork",
			session: liveSession("scouting"),
			status: "running",
			activity: "Scouting",
		});
		const fork = {
			session: toolSession(cwd, {
				forkSource: path.join(tempDir.path(), "source.jsonl"),
				agentRegistry: registry,
				getAgentId: () => "MeshAskFork",
			}),
		};
		const ordinary = { session: toolSession(cwd, { agentRegistry: registry, getAgentId: () => "Main" }) };
		const router = InternalUrlRouter.instance();

		expect((await router.resolve("proc://", ordinary)).content).toContain("peer-A-secret-plan");
		const listing = (await router.resolve("proc://", fork)).content;
		expect(listing).toContain("0-Scout");
		expect(listing).not.toContain("MeshAsk ");
		expect(listing).not.toContain("peer-A-secret-plan");
		expect(await rejection(router.resolve("proc://MeshAsk", fork))).toContain("not found");
	});
});
