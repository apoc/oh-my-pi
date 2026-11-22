import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { combine, operatorValue } from "@oh-my-pi/pi-coding-agent/config/registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgMeshEnabled, cfgMeshInboundTask } from "@oh-my-pi/pi-coding-agent/mesh/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const dirs: TempDir[] = [];

afterEach(async () => {
	resetSettingsForTest();
	for (const dir of dirs.splice(0)) await dir.remove();
});

/** Global and project layers both enabling the mesh and allowing remote tasks. */
async function shadowedSettings(): Promise<Settings> {
	const dir = TempDir.createSync("@omp-operator-value-");
	dirs.push(dir);
	const agentDir = path.join(dir.path(), "agent");
	const cwd = path.join(dir.path(), "project");
	const layer = YAML.stringify({ mesh: { enabled: true, inbound: { task: "allow" } } });
	await Bun.write(path.join(agentDir, "config.yml"), layer);
	await Bun.write(path.join(cwd, ".omp", "config.yml"), layer);
	return Settings.loadReadOnly({ agentDir, cwd });
}

describe("operatorValue listeners", () => {
	// A project layer shadowing the setting leaves the merged value unchanged on an operator
	// write; listeners must still see the operator value change (e.g. /mesh turning the mesh off).
	it("fire on an operator write that a project layer shadows", async () => {
		const settings = await shadowedSettings();
		const enabled = operatorValue(cfgMeshEnabled);
		const seen: boolean[] = [];
		enabled.listen(settings, value => {
			seen.push(value);
		});

		cfgMeshEnabled.set(settings, false);
		await Promise.resolve(); // listeners coalesce per microtask

		expect(enabled.get(settings)).toBe(false);
		expect(seen).toEqual([false]);
	});

	it("fire on a derived overlay when the root's operator layer changes", async () => {
		const root = await shadowedSettings();
		const sub = root.overlay().overlay({}, { derived: true });
		const enabled = operatorValue(cfgMeshEnabled);
		const seen: boolean[] = [];
		enabled.listen(sub, value => {
			seen.push(value);
		});

		cfgMeshEnabled.set(root, false);
		await Promise.resolve(); // listeners coalesce per microtask

		expect(seen).toEqual([false]);
	});

	it("reach derivations built on an operator value", async () => {
		const settings = await shadowedSettings();
		const policy = combine({
			enabled: operatorValue(cfgMeshEnabled),
			task: operatorValue(cfgMeshInboundTask).map(task => task === "allow"),
		});
		const seen: { enabled: boolean; task: boolean }[] = [];
		policy.listen(settings, value => {
			seen.push(value);
		});

		cfgMeshInboundTask.set(settings, "deny");
		await Promise.resolve(); // listeners coalesce per microtask

		expect(seen).toEqual([{ enabled: true, task: false }]);
	});
});
