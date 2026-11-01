/**
 * This process's same-machine instance: one endpoint and one entry in the owner-only registry
 * `~/.omp/run/instances` (`PI_CONFIG_DIR` replaces `.omp`), shared by every namespace it serves
 * (mesh and collab). Every caller goes through {@link sharedInstanceHost}.
 */
import * as os from "node:os";
import * as path from "node:path";
import { InstanceHost } from "@oh-my-pi/pi-natives";
import {
	getBaseConfigRoot,
	isBunTestEntrypoint,
	isBunTestRuntime,
	isEnvFromProjectDotenv,
	postmortem,
} from "@oh-my-pi/pi-utils";

let withdrawRegistered = false;
let registryDir: string | undefined;

/**
 * The registry directory of {@link sharedInstanceHost}, decided once per process on first use
 * (the process-wide host can only ever serve one directory). `bun test` processes get
 * `<tmpdir>/omp-test-instances-<uid>` instead (like the logs dir), so suites never publish into
 * the developer's real registry and a test that later changes HOME or TMPDIR never asks the
 * process-wide host for a different directory. Outside a `bun test` entrypoint the
 * `PI_TEST_RUNTIME` marker counts only when it did not come from the working directory's dotenv
 * files (`.env`, `.env.<mode>`, `.env.local`), so a cloned repository cannot move a real
 * instance's registry; the user's own home, config-root and agent `.env` files are trusted.
 */
export function instanceRegistryDir(): string {
	if (registryDir !== undefined) return registryDir;
	const testRuntime = isBunTestEntrypoint() || (isBunTestRuntime() && !isEnvFromProjectDotenv("PI_TEST_RUNTIME"));
	if (testRuntime) {
		const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
		registryDir = path.join(os.tmpdir(), `omp-test-instances-${uid}`);
	} else {
		registryDir = path.join(getBaseConfigRoot(), "run", "instances");
	}
	return registryDir;
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
