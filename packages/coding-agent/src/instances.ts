/**
 * This process's same-machine instance: one endpoint and one entry in the owner-only registry
 * `~/.omp/run/instances` (`PI_CONFIG_DIR` replaces `.omp`), shared by every namespace it serves
 * (mesh and collab). Every caller goes through {@link sharedInstanceHost}.
 */
import * as os from "node:os";
import * as path from "node:path";
import { InstanceHost } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, isBunTestRuntime, postmortem } from "@oh-my-pi/pi-utils";

let withdrawRegistered = false;
let testRegistryDir: string | undefined;

/**
 * The registry directory of {@link sharedInstanceHost}. `bun test` processes get
 * `<tmpdir>/omp-test-instances-<uid>` instead (like the logs dir), fixed on first use, so suites
 * never publish into the developer's real registry and a test that later changes HOME or TMPDIR
 * never asks the process-wide host for a different directory.
 */
export function instanceRegistryDir(): string {
	if (isBunTestRuntime()) {
		if (testRegistryDir === undefined) {
			const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
			testRegistryDir = path.join(os.tmpdir(), `omp-test-instances-${uid}`);
		}
		return testRegistryDir;
	}
	return path.join(getBaseConfigRoot(), "run", "instances");
}

/**
 * The process-wide instance host (created on first use with a random id). Its entry and endpoint
 * are withdrawn synchronously when the process exits.
 */
export function sharedInstanceHost(): InstanceHost {
	const host = InstanceHost.shared(instanceRegistryDir());
	if (!withdrawRegistered) {
		withdrawRegistered = true;
		postmortem.register("instance-host", () => host.withdrawSync(), { exitOnly: true });
	}
	return host;
}
