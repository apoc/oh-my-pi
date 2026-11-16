import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	InternalUrlRouter,
	LocalProtocolHandler,
	type ResolveContext,
	type SchemeHost,
	VaultProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ShellFsOp } from "@oh-my-pi/pi-natives";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const CONFINED = "confined forks (mesh ask responders and their subagents)";
const READ = { read: true, write: false, append: false, truncate: false, create: false, createNew: false };

let cleanupRoot: string;
let previousAgentDir: string;
let cwd: string;
let memoryRoot: string;
let settings: Settings;

function toolSession(forkSource: string | undefined): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		forkSource,
	};
}

function context(forkSource: string | undefined): ResolveContext {
	return { cwd, settings, session: toolSession(forkSource) };
}

const confined = () => context(path.join(cleanupRoot, "source-session.jsonl"));
const unconfined = () => context(undefined);

beforeEach(async () => {
	AgentRegistry.resetGlobalForTests();
	InternalUrlRouter.resetForTests();
	LocalProtocolHandler.resetOverrideForTests();
	cleanupRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "confined-fork-schemes-")));
	previousAgentDir = getAgentDir();
	const agentDir = path.join(cleanupRoot, "agent");
	cwd = path.join(cleanupRoot, "project");
	await fs.mkdir(cwd, { recursive: true });
	setAgentDir(agentDir);
	memoryRoot = getMemoryRoot(agentDir, cwd);
	await fs.mkdir(memoryRoot, { recursive: true });
	await Bun.write(path.join(memoryRoot, "memory_summary.md"), "private summary");
	settings = Settings.isolated({ "memory.backend": "local" });
	// locateSync reads memory roots from the registry.
	AgentRegistry.global().register({
		id: "test-main",
		displayName: "test",
		kind: "main",
		session: {
			sessionManager: { getCwd: () => cwd, getArtifactsDir: () => null, getSessionId: () => "test" },
			settings,
		} as unknown as AgentSession,
		sessionFile: null,
	});
});

afterEach(async () => {
	AgentRegistry.resetGlobalForTests();
	InternalUrlRouter.resetForTests();
	LocalProtocolHandler.resetOverrideForTests();
	setAgentDir(previousAgentDir);
	await removeWithRetries(cleanupRoot);
});

describe("InternalUrlRouter confined-fork scheme gate", () => {
	// Inputs fail inside each handler before any I/O, so a missing gate surfaces as the
	// handler's own error rather than a network call or a read of the real ~/.ssh.
	it.each([
		["ssh", "ssh:///x"],
		["issue", "issue://abc"],
		["pr", "pr://abc"],
		["mr", "mr://abc"],
		["vault", "vault://?op=bogus"],
		["memory", "memory://root"],
	])("refuses %s:// resolve for a confined session", async (scheme, url) => {
		await expect(InternalUrlRouter.instance().resolve(url, confined())).rejects.toThrow(
			`${scheme}:// is unavailable: ${CONFINED} cannot use ${scheme}:// URLs.`,
		);
	});

	it("resolves memory:// for a non-confined session", async () => {
		const resource = await InternalUrlRouter.instance().resolve("memory://root", unconfined());
		expect(resource.content).toBe("private summary");
	});

	it("leaves ssh:// to its handler for a non-confined session", async () => {
		await expect(InternalUrlRouter.instance().resolve("ssh:///etc/hosts", unconfined())).rejects.toThrow(
			"requires a host before the path",
		);
	});

	it("refuses memory:// locate, target and write for a confined session", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.locate("memory://root", confined())).rejects.toThrow(CONFINED);
		await expect(router.target("memory://root", confined())).rejects.toThrow(CONFINED);
		await expect(router.write("memory://root/x.md", "x", { session: confined().session })).rejects.toThrow(CONFINED);
		expect(router.locateSync("memory://root/memory_summary.md", confined())).toBeUndefined();
	});

	it("leaves memory:// writes to the handler policy for a non-confined session", async () => {
		await expect(
			InternalUrlRouter.instance().write("memory://root/x.md", "x", { session: unconfined().session }),
		).rejects.toThrow("memory:// URLs are read-only for write");
	});

	it("gates enumerate for denied schemes by caller", async () => {
		// No built-in denied scheme enumerates; a host-registered one must still be gated.
		const router = InternalUrlRouter.instance();
		const vault = new VaultProtocolHandler();
		const leaves = [{ url: "vault://a.md", content: "a" }];
		router.register({
			scheme: vault.scheme,
			spec: { ...vault.spec, write: undefined },
			resolve: url => vault.resolve(url),
			enumerate: async () => leaves,
		});
		await expect(router.enumerate("vault://", confined())).rejects.toThrow(CONFINED);
		expect(await router.enumerate("vault://", unconfined())).toEqual(leaves);
	});

	it("locates memory:// for a non-confined session", async () => {
		const router = InternalUrlRouter.instance();
		const summary = path.join(memoryRoot, "memory_summary.md");
		expect(await router.locate("memory://root/memory_summary.md", unconfined())).toBe(summary);
		expect(await router.target("memory://root/memory_summary.md", unconfined())).toMatchObject({
			kind: "file",
			path: summary,
		});
		expect(router.locateSync("memory://root/memory_summary.md", unconfined())).toBe(summary);
	});

	it("offers no completions for denied schemes to a confined session", async () => {
		const router = InternalUrlRouter.instance();
		expect(await router.complete("memory", "", confined())).toEqual([]);
		expect(await router.complete("ssh", "", confined())).toEqual([]);
		expect(await router.complete("MEMORY", "", confined())).toEqual([]);
		expect(await router.complete("memory", "", unconfined())).toContainEqual(
			expect.objectContaining({ value: "root" }),
		);
	});

	it("still resolves allowed schemes for a confined session", async () => {
		const artifactsDir = path.join(cleanupRoot, "artifacts");
		await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
		await Bun.write(path.join(artifactsDir, "local", "note.md"), "allowed");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const resource = await InternalUrlRouter.instance().resolve("local://note.md", confined());
		expect(resource.content).toBe("allowed");
	});
});

describe("InternalUrlRouter confined-fork prompt advertisement", () => {
	const DENIED = ["ssh", "issue", "pr", "mr", "vault", "memory"];
	const host: SchemeHost = {
		skillUriAccess: false,
		ruleCount: 0,
		memoryBackend: "local",
		securityEnabled: false,
		settingsApproval: false,
		outReplies: false,
		subagent: false,
		mesh: false,
		confined: false,
	};

	/** Registers always-advertising stubs for the denied schemes (the real handlers depend on `gh`/`ssh`/Obsidian binaries) plus one allowed scheme. */
	function advertiseStubs(router: InternalUrlRouter): InternalUrlRouter {
		for (const scheme of [...DENIED, "scratch"]) {
			router.register({
				scheme,
				spec: { backing: "virtual", selectors: "none", immutable: true },
				promptDoc: () => `${scheme}:// advertised`,
				promptReference: () => `${scheme}:// reference`,
				resolve: async url => ({ url: url.href, content: "", contentType: "text/plain" }),
			});
		}
		return router;
	}
	const schemesOf = (lines: string[]) => lines.map(line => line.slice(0, line.indexOf("://")));

	it("omits every denied scheme from a confined host and keeps the rest", () => {
		const router = advertiseStubs(new InternalUrlRouter());
		const open = schemesOf(router.describe({ ...host, confined: false }));
		for (const scheme of DENIED) expect(open).toContain(scheme);

		const confinedLines = schemesOf(router.describe({ ...host, confined: true }));
		for (const scheme of DENIED) expect(confinedLines).not.toContain(scheme);
		expect(confinedLines).toContain("scratch");
		expect(confinedLines).toContain("proc");
		expect(confinedLines).toEqual(open.filter(scheme => !DENIED.includes(scheme)));
	});

	it("omits every denied scheme from a confined reference and keeps the rest", () => {
		const router = advertiseStubs(new InternalUrlRouter());
		const open = schemesOf(router.reference());
		for (const scheme of DENIED) expect(open).toContain(scheme);
		expect(schemesOf(router.reference({ confined: false }))).toEqual(open);

		const confinedLines = schemesOf(router.reference({ confined: true }));
		for (const scheme of DENIED) expect(confinedLines).not.toContain(scheme);
		expect(confinedLines).toContain("scratch");
		expect(confinedLines).toContain("proc");
		expect(confinedLines).toEqual(open.filter(scheme => !DENIED.includes(scheme)));
	});

	it("renders xd://read/urls without denied schemes for a confined read tool only", () => {
		advertiseStubs(InternalUrlRouter.instance());
		const urls = (forkSource: string | undefined) => new ReadTool(toolSession(forkSource)).docTopics().urls;

		const open = urls(undefined);
		for (const scheme of DENIED) expect(open).toContain(`- ${scheme}:// reference`);

		const confinedTopic = urls(path.join(cleanupRoot, "source-session.jsonl"));
		for (const scheme of DENIED) expect(confinedTopic).not.toContain(`${scheme}:// reference`);
		expect(confinedTopic).toContain("- scratch:// reference");
	});
});

describe("InternalUrlFilesystem confined-fork scheme gate", () => {
	const open = (ctx: ResolveContext, url: string) =>
		new InternalUrlFilesystem({ context: ctx, tier: "exec" }).handle({ op: ShellFsOp.Open, path: url, open: READ });

	it("refuses memory:// files and directories for a confined session", async () => {
		const file = await open(confined(), "memory://root/memory_summary.md");
		expect(file.error?.code).toBe("EACCES");
		expect(file.error?.message).toContain(CONFINED);
		const dir = await new InternalUrlFilesystem({ context: confined(), tier: "exec" }).handle({
			op: ShellFsOp.ReadDir,
			path: "memory://root",
		});
		expect(dir.error?.code).toBe("EACCES");
		const upper = await open(confined(), "MEMORY://root/memory_summary.md");
		expect(upper.error?.code).toBe("EACCES");
	});

	it("opens memory:// for a non-confined session", async () => {
		expect(await open(unconfined(), "memory://root/memory_summary.md")).toMatchObject({
			local: path.join(memoryRoot, "memory_summary.md"),
		});
	});
});
