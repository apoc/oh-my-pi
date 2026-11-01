/**
 * The TypeScript adapter over the native collab registry (`pi_instances::collab`):
 * publication through an `InstanceHost`, the one-tick source answer, and the
 * mapping of native failures to `CollabLinkError`. The registry engine itself
 * (wire checks, pruning, sorting, selectors, bounding, directory security) is
 * covered by `crates/pi-instances/src/tests/collab.rs` and `list.rs`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CollabHostPublication,
	type CollabHostRegistrySource,
	type CollabHostSnapshot,
	CollabLinkError,
	listCollabHosts,
	publishCollabHost,
	resolveCollabHostLink,
} from "@oh-my-pi/pi-coding-agent/collab/registry";
import { InstanceHost } from "@oh-my-pi/pi-natives";

const cleanupDirs: string[] = [];
const openPublications: CollabHostPublication[] = [];
const openHosts: InstanceHost[] = [];

afterEach(async () => {
	for (const pub of openPublications.splice(0)) await pub.close();
	for (const host of openHosts.splice(0)) await host.close();
	for (const dir of cleanupDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-registry-"));
	cleanupDirs.push(dir);
	return dir;
}

/** A fresh 16-char lowercase alphanumeric instance id. */
function instanceId(): string {
	return crypto.randomBytes(8).toString("hex");
}

function newHost(dir: string, id = instanceId()): InstanceHost {
	const host = new InstanceHost({ dir, instanceId: id });
	openHosts.push(host);
	return host;
}

interface Fixture {
	snapshot: CollabHostSnapshot;
	roomKey: string;
	writeToken: string;
	controlUrl: string;
	viewUrl: string;
}

function makeFixture(over: Partial<CollabHostSnapshot> = {}): Fixture {
	const roomKey = `ROOMKEY-${crypto.randomBytes(6).toString("hex")}`;
	const writeToken = `WRITETOKEN-${crypto.randomBytes(6).toString("hex")}`;
	return {
		snapshot: {
			instanceId: instanceId(),
			generation: 1,
			sessionId: `sess-${crypto.randomBytes(4).toString("hex")}`,
			sessionName: "Fixture Session",
			cwd: "/tmp/fixture-cwd",
			pid: process.pid,
			model: { provider: "test", id: "fixture-model" },
			startedAt: 1_700_000_000_000,
			participants: 3,
			relayConnected: true,
			inputRequired: false,
			busy: false,
			access: "control",
			...over,
		},
		roomKey,
		writeToken,
		controlUrl: `https://collab.example/control/#room=${roomKey}&k=${writeToken}`,
		viewUrl: `https://collab.example/view/#room=${roomKey}`,
	};
}

function sourceFor(f: Fixture): CollabHostRegistrySource {
	return {
		snapshot: () => f.snapshot,
		link: access => (access === "view" ? f.viewUrl : f.snapshot.access === "control" ? f.controlUrl : null),
	};
}

async function publishSource(
	dir: string,
	id: string,
	source: CollabHostRegistrySource,
): Promise<CollabHostPublication> {
	const pub = await publishCollabHost(source, { host: newHost(dir, id) });
	openPublications.push(pub);
	return pub;
}

function publish(dir: string, f: Fixture): Promise<CollabHostPublication> {
	return publishSource(dir, f.snapshot.instanceId, sourceFor(f));
}

async function collectRegularFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await collectRegularFiles(full)));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

describe("collab registry", () => {
	it("lists metadata without capabilities and resolves only the requested access by instance ID", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);

		const hosts = await listCollabHosts({ dir });
		expect(hosts).toEqual([f.snapshot]);
		expect(hosts[0]).not.toHaveProperty("url");
		expect(JSON.stringify(hosts)).not.toContain(f.roomKey);
		expect(JSON.stringify(hosts)).not.toContain(f.writeToken);

		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toEqual({
			instanceId: f.snapshot.instanceId,
			generation: f.snapshot.generation,
			access: "control",
			url: f.controlUrl,
		});
		const view = await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir });
		expect(view).toEqual({
			instanceId: f.snapshot.instanceId,
			generation: f.snapshot.generation,
			access: "view",
			url: f.viewUrl,
		});
		expect(JSON.stringify(view)).not.toContain(f.controlUrl);
		expect(JSON.stringify(view)).not.toContain(f.writeToken);
	});

	it("reports the publishing host's identity whatever the source claims", async () => {
		const dir = await tempDir();
		const f = makeFixture({ instanceId: "not-the-host-id", pid: 1 });
		const id = instanceId();
		await publishSource(dir, id, sourceFor(f));

		expect(await listCollabHosts({ dir })).toMatchObject([{ instanceId: id, pid: process.pid }]);
	});

	it("keeps a nullable session name, model and busy flag as null", async () => {
		const dir = await tempDir();
		const f = makeFixture({ sessionName: null, model: null, busy: null });
		await publish(dir, f);

		const [host] = await listCollabHosts({ dir });
		expect(host).toEqual(f.snapshot);
		expect(JSON.stringify(host)).toContain('"sessionName":null');
	});

	it("maps native link failures to CollabLinkError with the native code and message", async () => {
		const dir = await tempDir();
		const viewOnly = makeFixture({ access: "view" });
		await publish(dir, viewOnly);

		const denied = await resolveCollabHostLink(viewOnly.snapshot.instanceId, "control", { dir }).catch(e => e);
		expect(denied).toBeInstanceOf(CollabLinkError);
		expect(denied).toMatchObject({
			name: "CollabLinkError",
			code: "access_unavailable",
			message: `host ${viewOnly.snapshot.instanceId} does not publish control access`,
		});
		expect(await resolveCollabHostLink(viewOnly.snapshot.instanceId, "view", { dir })).toMatchObject({
			access: "view",
			url: viewOnly.viewUrl,
		});

		const missing = await resolveCollabHostLink("  missing-host ", "control", { dir }).catch(e => e);
		expect(missing).toBeInstanceOf(CollabLinkError);
		expect(missing).toMatchObject({ code: "not_found", message: "no active Collab host matches missing-host" });

		const second = makeFixture();
		await publish(dir, second);
		const ambiguous = await resolveCollabHostLink(String(process.pid), "control", { dir }).catch(e => e);
		expect(ambiguous).toBeInstanceOf(CollabLinkError);
		expect(ambiguous.code).toBe("ambiguous");
		expect(ambiguous.message).toStartWith(`${process.pid} matches more than one Collab host; use an instance id: `);
	});

	it("surfaces stale_generation when the host rotates between resolution's listing and link request", async () => {
		const dir = await tempDir();
		const f = makeFixture({ access: "view" });
		const source = sourceFor(f);
		let rotate = false;
		source.snapshot = () => {
			const snapshot = { ...f.snapshot };
			if (rotate) {
				// The next generation is a control room: the caller must be told to
				// re-list, not that control is unavailable.
				f.snapshot = { ...f.snapshot, generation: f.snapshot.generation + 1, access: "control" };
				rotate = false;
			}
			return snapshot;
		};
		await publishSource(dir, f.snapshot.instanceId, source);
		rotate = true;

		await expect(resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "stale_generation",
		});
		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toMatchObject({
			generation: 2,
			url: f.controlUrl,
		});
	});

	it("omits a host whose source throws or answers a malformed snapshot, without leaking the error", async () => {
		const dir = await tempDir();
		const healthy = makeFixture({ sessionId: "healthy" });
		await publish(dir, healthy);
		await publishSource(dir, instanceId(), {
			snapshot: () => {
				throw new Error(`secret ${healthy.controlUrl}`);
			},
			link: () => healthy.controlUrl,
		});
		const garbage = makeFixture({ sessionId: "garbage", busy: "yes" as unknown as boolean });
		await publish(dir, garbage);
		const fractional = makeFixture({ sessionId: "fractional", generation: 1.5 });
		await publish(dir, fractional);
		const throwingLink = makeFixture({ sessionId: "throwing-link" });
		await publishSource(dir, throwingLink.snapshot.instanceId, {
			snapshot: () => throwingLink.snapshot,
			link: () => {
				throw new Error("room gone");
			},
		});

		const hosts = await listCollabHosts({ dir });
		expect(hosts.map(host => host.sessionId).sort()).toEqual(["healthy", "throwing-link"]);
		await expect(resolveCollabHostLink(throwingLink.snapshot.instanceId, "control", { dir })).rejects.toMatchObject({
			code: "unreachable",
		});
	});

	it("keeps both URLs and room secrets off disk even after resolving links", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);
		await listCollabHosts({ dir });
		await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir });
		await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir });

		const files = await collectRegularFiles(dir);
		expect(files.filter(file => file.endsWith(".json"))).toHaveLength(1);
		for (const file of files) {
			const content = await Bun.file(file).text();
			expect(content).not.toContain(f.controlUrl);
			expect(content).not.toContain(f.viewUrl);
			expect(content).not.toContain(f.roomKey);
			expect(content).not.toContain(f.writeToken);
		}
	});

	it("withdraws the collab capability on close while the instance host stays published", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const host = newHost(dir, f.snapshot.instanceId);
		const pub = await publishCollabHost(sourceFor(f), { host });
		expect(await listCollabHosts({ dir })).toHaveLength(1);
		await pub.close();
		await pub.close();

		expect(await listCollabHosts({ dir })).toEqual([]);
		const entry = await Bun.file(path.join(dir, `${f.snapshot.instanceId}.json`)).json();
		expect(entry.capabilities).toEqual([]);

		// The namespace is free again: a successor room publishes on the same host.
		const successor = makeFixture({ instanceId: f.snapshot.instanceId, generation: 2 });
		openPublications.push(await publishCollabHost(sourceFor(successor), { host }));
		expect(await listCollabHosts({ dir })).toMatchObject([{ generation: 2 }]);

		await host.close();
		expect((await fs.readdir(dir)).filter(name => name.endsWith(".json"))).toEqual([]);
	});

	it("refuses a second publication on one host and any publication on a closed host", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const host = newHost(dir, f.snapshot.instanceId);
		openPublications.push(await publishCollabHost(sourceFor(f), { host }));
		await expect(publishCollabHost(sourceFor(f), { host })).rejects.toThrow(/collab/);

		const closed = newHost(dir);
		await closed.close();
		await expect(publishCollabHost(sourceFor(makeFixture()), { host: closed })).rejects.toThrow();
	});

	it("lists nothing for a missing directory and rejects a symlinked one with a non-link code", async () => {
		const base = await tempDir();
		expect(await listCollabHosts({ dir: path.join(base, "absent") })).toEqual([]);

		const target = await tempDir();
		const bystander = path.join(target, "important.json");
		await Bun.write(bystander, "{not registry metadata");
		const link = path.join(base, "instances");
		await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");

		const listed = await listCollabHosts({ dir: link }).catch(e => e);
		expect(listed).toMatchObject({ code: "registry_dir" });
		expect(listed).not.toBeInstanceOf(CollabLinkError);
		const resolved = await resolveCollabHostLink("anything", "view", { dir: link }).catch(e => e);
		expect(resolved).toMatchObject({ code: "registry_dir" });
		expect(resolved).not.toBeInstanceOf(CollabLinkError);
		await expect(publishCollabHost(sourceFor(makeFixture()), { host: newHost(link) })).rejects.toThrow(/symlink/);
		expect(await fs.readdir(target)).toEqual(["important.json"]);
	});
});
