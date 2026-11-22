/**
 * A confined fork finds its source's `local://` root even when the source keeps
 * it under the temp dir (long Windows artifacts paths), which is named by the
 * source's session id.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { spillFileName, TempDir } from "@oh-my-pi/pi-utils";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function sessionHeader(id: string, cwd: string, extra: Record<string, string> = {}): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: new Date().toISOString(),
		cwd,
		...extra,
	});
}

function sourceSessionJsonl(id: string, cwd: string): string {
	const entry = {
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "source question", timestamp: 1 },
	};
	return `${sessionHeader(id, cwd)}\n${JSON.stringify(entry)}\n`;
}

interface Fixture {
	sourceFile: string;
	sourceId: string;
	/** Where the source keeps `local://` on win32: `%TEMP%/omp-local/<sourceId>`. */
	sourceLocalRoot: string;
	cwd: string;
	dir: string;
}

async function setup(dir: string): Promise<Fixture> {
	const cwd = path.join(dir, "project");
	// `<artifacts>/local` past 180 chars sends win32 to the session-id root.
	const sourceFile = path.join(dir, "s".repeat(100), "t".repeat(100), "source.jsonl");
	const sourceId = `fork-src-${crypto.randomUUID()}`;
	await Bun.write(sourceFile, sourceSessionJsonl(sourceId, cwd));
	const sourceLocalRoot = path.join(os.tmpdir(), "omp-local", sourceId);
	await Bun.write(path.join(sourceLocalRoot, spillFileName(0)), "source spill\n");
	return { sourceFile, sourceId, sourceLocalRoot, cwd, dir };
}

function confinedFork(fixture: Fixture): Promise<SessionManager> {
	return SessionManager.forkFrom(fixture.sourceFile, fixture.cwd, undefined, undefined, {
		confined: true,
		suppressBreadcrumb: true,
		sessionFile: path.join(fixture.dir, "forks", "Fork.jsonl"),
	});
}

/** Runs `fn` with `process.platform` reading `win32` (the long-path root branch), restored after. */
async function asWin32<T>(fn: () => Promise<T>): Promise<T> {
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	try {
		return await fn();
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
}

describe("local:// root of a confined fork's source", () => {
	const cleanup: string[] = [];

	beforeEach(() => {
		InternalUrlRouter.resetForTests();
	});

	afterEach(async () => {
		InternalUrlRouter.resetForTests();
		for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	it("records the source session id and reserves the source's spill ids", async () => {
		using tempDir = TempDir.createSync("@omp-local-fork-");
		const fixture = await setup(tempDir.path());
		cleanup.push(fixture.sourceLocalRoot);

		await asWin32(async () => {
			const fork = await confinedFork(fixture);
			expect(fork.getForkSourceSessionId()).toBe(fixture.sourceId);
			// Spill 0 lives in the source root, so the fork allocates past it.
			expect((await fork.allocateArtifactPath()).id).toBe("1");
		});
	});

	it("records the source session id for a session confined to a fork source", async () => {
		using tempDir = TempDir.createSync("@omp-local-fork-");
		const fixture = await setup(tempDir.path());
		cleanup.push(fixture.sourceLocalRoot);

		const sub = SessionManager.inMemory(fixture.cwd, undefined, { forkSource: fixture.sourceFile });
		expect(sub.getForkSourceSessionId()).toBe(fixture.sourceId);
		expect(SessionManager.inMemory(fixture.cwd).getForkSourceSessionId()).toBeNull();
	});

	it("reads the source id from the source header when the fork header predates the field", async () => {
		using tempDir = TempDir.createSync("@omp-local-fork-");
		const fixture = await setup(tempDir.path());
		cleanup.push(fixture.sourceLocalRoot);
		const forkFile = path.join(fixture.dir, "forks", "Old.jsonl");
		await Bun.write(forkFile, `${sessionHeader("old-fork", fixture.cwd, { forkSource: fixture.sourceFile })}\n`);

		await asWin32(async () => {
			const fork = await SessionManager.open(forkFile);
			expect(fork.getForkSource()).toBe(fixture.sourceFile);
			expect(fork.getForkSourceSessionId()).toBe(fixture.sourceId);
			// The source root, not the shared session-less one: spill 0 is reserved.
			expect((await fork.allocateArtifactPath()).id).toBe("1");
		});
	});

	it("reads a source spill through local:// from the fork", async () => {
		using tempDir = TempDir.createSync("@omp-local-fork-");
		const fixture = await setup(tempDir.path());
		cleanup.push(fixture.sourceLocalRoot);
		await asWin32(async () => {
			const fork = await confinedFork(fixture);
			const session: ToolSession = {
				cwd: fixture.cwd,
				hasUI: false,
				getSessionFile: () => fork.getSessionFile() ?? null,
				getSessionSpawns: () => "*",
				getArtifactsDir: () => fork.getArtifactsDir(),
				settings: Settings.isolated(),
				forkSourceArtifactsDir: fork.getForkSourceArtifactsDir() ?? undefined,
				forkSourceSessionId: fork.getForkSourceSessionId() ?? undefined,
			};
			const context = {
				session,
				localProtocolOptions: {
					getArtifactsDir: () => fork.getArtifactsDir(),
					getSessionId: () => fork.getSessionId(),
				},
			};

			const resource = await InternalUrlRouter.instance().resolve(`local://${spillFileName(0)}`, context);
			expect(resource.content).toBe("source spill\n");
		});
	});
});
