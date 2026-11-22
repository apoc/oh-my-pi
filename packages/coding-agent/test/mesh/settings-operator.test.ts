import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { setMeshRuntime, type MeshRuntime } from "@oh-my-pi/pi-coding-agent/mesh/runtime";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import {
	cfgMeshInboundPolicy,
	cfgMeshKey,
	cfgOperatorMeshEnabled,
	cfgOperatorMeshKey,
	meshConfigFromSettings,
} from "@oh-my-pi/pi-coding-agent/mesh/settings";
import type { SettingsDisplayEntry } from "@oh-my-pi/pi-coding-agent/config/settings-defs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ScriptedMeshEngine } from "./scripted-engine";

/** 32 bytes `0x01` as unpadded base64url, the shape `omp mesh set-key` stores. */
const DERIVED_KEY = Buffer.alloc(32, 1).toString("base64url");
/** 32 bytes `0x07` as unpadded base64url. */
const OTHER_KEY = Buffer.alloc(32, 7).toString("base64url");

const LOOSE_MESH = {
	mesh: {
		enabled: true,
		mode: "both",
		key: OTHER_KEY,
		port: 4242,
		peers: ["10.0.0.9:4242"],
		inbound: { status: "deny", ask: "deny", steer: "allow", task: "allow", note: "deny" },
	},
};

interface Layers {
	global?: unknown;
	project?: unknown;
}

const dirs: TempDir[] = [];

afterEach(async () => {
	setMeshRuntime(undefined);
	resetSettingsForTest();
	for (const dir of dirs.splice(0)) await dir.remove();
});

/** Writes the global (`<agentDir>/config.yml`) and project (`<cwd>/.omp/config.yml`) layers. */
async function writeLayers(layers: Layers): Promise<{ agentDir: string; cwd: string }> {
	const dir = TempDir.createSync("@omp-mesh-operator-");
	dirs.push(dir);
	const agentDir = path.join(dir.path(), "agent");
	const cwd = path.join(dir.path(), "project");
	await Bun.write(path.join(agentDir, "config.yml"), layers.global ? YAML.stringify(layers.global) : "");
	await Bun.write(path.join(cwd, ".omp", "config.yml"), layers.project ? YAML.stringify(layers.project) : "");
	return { agentDir, cwd };
}

async function load(layers: Layers): Promise<Settings> {
	return Settings.loadReadOnly(await writeLayers(layers));
}

describe("mesh settings a project layer supplies", () => {
	it("cannot enable the mesh, set its connection or loosen inbound policies", async () => {
		const settings = await load({ project: LOOSE_MESH });

		expect(cfgOperatorMeshEnabled.get(settings)).toBe(false);
		expect(cfgOperatorMeshKey.get(settings)).toBe("");
		expect(cfgMeshInboundPolicy.task.get(settings)).toBe("deny");
		expect(cfgMeshInboundPolicy.steer.get(settings)).toBe("ask");
		expect(meshConfigFromSettings(settings)).toMatchObject({
			mode: "local",
			key: undefined,
			lanPort: 0,
			staticPeers: [],
			deniedKinds: ["task"],
		});
	});

	it("leaves the operator's global values in force", async () => {
		const settings = await load({
			global: { mesh: { enabled: true, key: DERIVED_KEY, inbound: { task: "ask" } } },
			project: { mesh: { enabled: false, key: OTHER_KEY, inbound: { task: "deny" } } },
		});

		expect(cfgOperatorMeshEnabled.get(settings)).toBe(true);
		expect(cfgOperatorMeshKey.get(settings)).toBe(DERIVED_KEY);
		expect(cfgMeshInboundPolicy.task.get(settings)).toBe("ask");
	});
});

describe("mesh settings the operator configures", () => {
	it("take effect from the global layer", async () => {
		const settings = await load({ global: LOOSE_MESH });

		expect(cfgOperatorMeshEnabled.get(settings)).toBe(true);
		expect(cfgMeshInboundPolicy.task.get(settings)).toBe("allow");
		expect(meshConfigFromSettings(settings)).toMatchObject({
			mode: "both",
			key: OTHER_KEY,
			lanPort: 4242,
			staticPeers: ["10.0.0.9:4242"],
			deniedKinds: ["status", "ask", "note"],
		});
	});
});

describe("mesh tools", () => {
	/** Mesh tools a top-level session gets while the mesh runtime serves it. */
	async function meshToolNames(layers: Layers): Promise<string[]> {
		const settings = await load(layers);
		const sessionManager = { getSessionId: () => "session-bound" } as unknown as NonNullable<
			ToolSession["sessionManager"]
		>;
		setMeshRuntime({
			engine: new ScriptedMeshEngine(),
			session: { sessionManager, settings },
		} as unknown as MeshRuntime);
		const session: ToolSession = {
			cwd: "/tmp/test",
			hasUI: false,
			skipPythonPreflight: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
			sessionManager,
		};
		const tools = await createTools(session);
		return [...tools.map(tool => tool.name), ...(session.toolCommands?.mountedNames ?? [])]
			.filter(name => name.startsWith("mesh_"))
			.sort();
	}

	it("are not offered when only the project layer enables the mesh", async () => {
		expect(await meshToolNames({ project: { mesh: { enabled: true } } })).toEqual([]);
	});

	it("are offered when the operator enables the mesh", async () => {
		expect(await meshToolNames({ global: { mesh: { enabled: true } } })).toEqual(["mesh_peers", "mesh_send"]);
	});
});

describe("mesh settings panel", () => {
	const OPERATOR_ONLY_IDS = [
		"mesh.enabled",
		"mesh.mode",
		"mesh.key",
		"mesh.port",
		"mesh.peers",
		"mesh.inbound.status",
		"mesh.inbound.ask",
		"mesh.inbound.steer",
		"mesh.inbound.task",
		"mesh.inbound.note",
	];

	function entryOf(entries: readonly SettingsDisplayEntry[], id: string): SettingsDisplayEntry {
		const entry = entries.find(candidate => candidate.path === id);
		if (!entry) throw new Error(`No settings-panel entry for ${id}`);
		return entry;
	}

	/** Row visibility per operator-only setting under the given layers. */
	async function rowVisibility(layers: Layers): Promise<Record<string, boolean | undefined>> {
		await Settings.init(await writeLayers(layers));
		const { entries } = createSettingsHost();
		return Object.fromEntries(OPERATOR_ONLY_IDS.map(id => [id, entryOf(entries, id).condition?.()]));
	}

	it("hides only the rows whose own setting a project layer supplies", async () => {
		const visibility = await rowVisibility({ project: { mesh: { inbound: { note: "allow" } } } });

		expect(visibility).toEqual({
			...Object.fromEntries(OPERATOR_ONLY_IDS.map(id => [id, true])),
			"mesh.inbound.note": false,
		});
	});

	it("shows every row when only the operator configures the mesh", async () => {
		const visibility = await rowVisibility({ global: { mesh: { enabled: true, inbound: { note: "allow" } } } });

		expect(Object.values(visibility)).toEqual(OPERATOR_ONLY_IDS.map(() => true));
	});

	it("states in every row description that project settings cannot set it", async () => {
		await Settings.init(await writeLayers({}));
		const { entries } = createSettingsHost();
		for (const id of OPERATOR_ONLY_IDS) {
			expect(entryOf(entries, id).ui?.description.endsWith("Project settings cannot set this.")).toBe(true);
		}
	});
});

describe("settings panel rows that hide a project-supplied value", () => {
	/** Visibility of each row under the given layers. */
	async function visibility(layers: Layers, ids: string[]): Promise<boolean[]> {
		resetSettingsForTest();
		await Settings.init(await writeLayers(layers));
		const { entries } = createSettingsHost();
		return ids.map(id => {
			const condition = entries.find(entry => entry.path === id)?.condition;
			if (!condition) throw new Error(`No condition on ${id}`);
			return condition();
		});
	}

	const IDS = ["contextFiles.extra", "tools.restrictedFolders", "task.perCallModelAllow", "auth.unpausedProviders"];

	it("hides a row only while a project layer supplies its own setting", async () => {
		const project = {
			contextFiles: { extra: ["AGENTS.local.md"] },
			tools: { restrictedFolders: ["~/secrets"] },
		};

		expect(await visibility({ project }, IDS)).toEqual([false, false, true, true]);
		expect(await visibility({ global: project }, IDS)).toEqual([true, true, true, true]);
		expect(await visibility({ project: { task: { perCallModelAllow: ["openai/gpt-4o"] } } }, IDS)).toEqual([
			true,
			true,
			false,
			true,
		]);
	});
});

describe("mesh.key", () => {
	it("rejects the key phrase typed in place of a derived key", () => {
		const settings = Settings.isolated();
		expect(() => cfgMeshKey.set(settings, "correct horse battery staple")).toThrow(
			"mesh.key must be the derived key, not the key phrase: remove `mesh.key` from your config file, then set the phrase via /mesh or `omp mesh set-key`",
		);
	});

	it("rejects padded or non-canonical base64url of 32 bytes", () => {
		const settings = Settings.isolated();
		expect(() => cfgMeshKey.set(settings, `${DERIVED_KEY}=`)).toThrow("mesh.key must be");
		// Same 43 characters with the trailing padding bits set: `MeshKeys::load` rejects it.
		const nonCanonical = `${DERIVED_KEY.slice(0, 42)}B`;
		expect(() => cfgMeshKey.set(settings, nonCanonical)).toThrow("mesh.key must be");
	});

	it("accepts a derived key and the empty value", () => {
		const settings = Settings.isolated();
		cfgMeshKey.set(settings, DERIVED_KEY);
		expect(cfgMeshKey.get(settings)).toBe(DERIVED_KEY);
		cfgMeshKey.set(settings, "");
		expect(cfgMeshKey.get(settings)).toBe("");
	});
});
