import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { MeshRuntime } from "../../src/mesh/runtime";
import { meshPeerCountsText } from "../../src/modes/components/mesh/mesh-manager-runtime";
import { ScriptedMeshEngine } from "./scripted-engine";

const LOCAL_PEERS = 2;
const REMOTE_PEERS = 3;

/** A runtime with the scripted engine's peer counts and `pending` approvals queued. */
function fakeRuntime(pending: number): MeshRuntime {
	const approvals = Array.from({ length: pending }, (_, index) => ({ id: `approval-${index}` }));
	const engine = new ScriptedMeshEngine();
	engine.counts = { local: LOCAL_PEERS, remote: REMOTE_PEERS };
	return { engine, frontend: { approvals: { list: () => approvals } } } as unknown as MeshRuntime;
}

function settings(mode: "local" | "remote" | "both", enabled = true): Settings {
	return Settings.isolated({ "mesh.enabled": enabled, "mesh.mode": mode });
}

describe("meshPeerCountsText", () => {
	it("is undefined without a running runtime, and while the mesh is disabled", () => {
		expect(meshPeerCountsText(settings("both"), undefined)).toBeUndefined();
		expect(meshPeerCountsText(settings("both", false), fakeRuntime(0))).toBeUndefined();
	});

	it("shows only the side the mode reaches, with no pending part when nothing awaits approval", () => {
		expect(meshPeerCountsText(settings("local"), fakeRuntime(0))).toBe(`${LOCAL_PEERS} local`);
		expect(meshPeerCountsText(settings("remote"), fakeRuntime(0))).toBe(`${REMOTE_PEERS} remote`);
		expect(meshPeerCountsText(settings("both"), fakeRuntime(0))).toBe(
			`${LOCAL_PEERS} local · ${REMOTE_PEERS} remote`,
		);
	});

	it("appends the pending approval count after the peer counts", () => {
		expect(meshPeerCountsText(settings("both"), fakeRuntime(2))).toBe(
			`${LOCAL_PEERS} local · ${REMOTE_PEERS} remote · 2 pending`,
		);
	});
});
