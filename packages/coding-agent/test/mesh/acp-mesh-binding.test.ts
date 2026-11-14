import { describe, expect, it } from "bun:test";
import type { MeshHostHandle, MeshHostOptions } from "../../src/mesh/host";
import { AcpMeshBinding } from "../../src/modes/acp/mesh-binding";
import type { AgentSession } from "../../src/session/agent-session";

/** A fake host whose dispose settles only when the test says so. */
interface FakeHost extends MeshHostHandle {
	readonly startedWith: AgentSession;
	readonly servedSessions: AgentSession[];
	disposeCalls: number;
	finishDispose(): void;
}

function fakeHosts(): { hosts: FakeHost[]; start: (options: MeshHostOptions) => MeshHostHandle } {
	const hosts: FakeHost[] = [];
	const start = (options: MeshHostOptions): MeshHostHandle => {
		const disposed = Promise.withResolvers<void>();
		const host: FakeHost = {
			startedWith: options.session,
			servedSessions: [],
			disposeCalls: 0,
			finishDispose: () => disposed.resolve(),
			setSession: async session => {
				host.servedSessions.push(session);
			},
			dispose: () => {
				host.disposeCalls++;
				return disposed.promise;
			},
		};
		hosts.push(host);
		return host;
	};
	return { hosts, start };
}

function session(name: string): AgentSession {
	return { name } as unknown as AgentSession;
}

/** Whether `promise` settles once every queued microtask has run (no wall-clock wait). */
function settlesNow(promise: Promise<unknown>): Promise<boolean> {
	const drained = Promise.withResolvers<boolean>();
	setImmediate(() => drained.resolve(false));
	return Promise.race([promise.then(() => true), drained.promise]);
}

describe("AcpMeshBinding", () => {
	it("serves the newest open session and leaves the mesh when the last one closes", async () => {
		const { hosts, start } = fakeHosts();
		const binding = new AcpMeshBinding(start);
		const first = session("first");
		const second = session("second");

		await binding.sync(() => [first]);
		await binding.sync(() => [first, second]);
		expect(hosts[0]!.servedSessions.at(-1)).toBe(second);
		await binding.sync(() => [second]);
		expect(hosts).toHaveLength(1);
		expect(hosts[0]!.startedWith).toBe(first);
		expect(hosts[0]!.servedSessions.at(-1)).toBe(second);

		hosts[0]!.finishDispose();
		await binding.sync(() => []);
		await binding.sync(() => []);
		expect(hosts[0]!.disposeCalls).toBe(1);
	});

	it("starts the next host only after the previous one finished closing", async () => {
		const { hosts, start } = fakeHosts();
		const binding = new AcpMeshBinding(start);
		await binding.sync(() => [session("first")]);

		const closing = binding.sync(() => []);
		const reopened = session("reopened");
		const reopening = binding.sync(() => [reopened]);
		expect(await settlesNow(reopening)).toBe(false);
		expect(hosts).toHaveLength(1);

		hosts[0]!.finishDispose();
		await Promise.all([closing, reopening]);
		expect(hosts).toHaveLength(2);
		expect(hosts[1]!.startedWith).toBe(reopened);
	});

	it("reads the open sessions when a queued sync runs, not when it was requested", async () => {
		const { hosts, start } = fakeHosts();
		const binding = new AcpMeshBinding(start);
		let open = [session("first")];
		await binding.sync(() => open);

		open = [];
		const closing = binding.sync(() => open);
		open = [session("short-lived")];
		const opening = binding.sync(() => open);
		// The short-lived session closes before the queued sync gets to run.
		open = [];

		hosts[0]!.finishDispose();
		await Promise.all([closing, opening]);
		expect(hosts).toHaveLength(1);
	});

	it("keeps serving later syncs after a host fails to start", async () => {
		const { hosts, start } = fakeHosts();
		let starts = 0;
		const binding = new AcpMeshBinding(options => {
			starts++;
			if (starts === 1) throw new Error("listener busy");
			return start(options);
		});
		const next = session("next");

		await binding.sync(() => [session("first")]);
		await binding.sync(() => [next]);
		expect(hosts).toHaveLength(1);
		expect(hosts[0]!.startedWith).toBe(next);
	});

	it("dispose waits for a host still closing after the last session left", async () => {
		const { hosts, start } = fakeHosts();
		const binding = new AcpMeshBinding(start);
		await binding.sync(() => [session("first")]);
		const closing = binding.sync(() => []);

		const disposing = binding.dispose();
		expect(await settlesNow(disposing)).toBe(false);
		hosts[0]!.finishDispose();
		await Promise.all([closing, disposing]);
		expect(hosts[0]!.disposeCalls).toBe(1);
	});

	it("dispose leaves the mesh from an open session and waits for the host to close", async () => {
		const { hosts, start } = fakeHosts();
		const binding = new AcpMeshBinding(start);
		await binding.sync(() => [session("first")]);

		const disposing = binding.dispose();
		expect(await settlesNow(disposing)).toBe(false);
		expect(hosts[0]!.disposeCalls).toBe(1);
		hosts[0]!.finishDispose();
		await disposing;
	});

	it("dispose refuses every sync not yet run, queued before or after it, while a host is still closing", async () => {
		const { hosts, start } = fakeHosts();
		const binding = new AcpMeshBinding(start);
		await binding.sync(() => [session("first")]);
		const closing = binding.sync(() => []);
		const queued = binding.sync(() => [session("a")]);
		const disposing = binding.dispose();
		const late = binding.sync(() => [session("b")]);

		hosts[0]!.finishDispose();
		await Promise.all([closing, queued, disposing, late]);

		expect(hosts).toHaveLength(1);
		expect(hosts[0]!.disposeCalls).toBe(1);
	});
});
