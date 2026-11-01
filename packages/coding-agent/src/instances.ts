/**
 * This process's same-machine instance: one endpoint and one entry in the owner-only registry
 * `~/.omp/run/instances` (`PI_CONFIG_DIR` replaces `.omp`), shared by every namespace it serves
 * (mesh today). Every caller goes through {@link sharedInstanceHost}.
 */
import * as path from "node:path";
import { InstanceHost } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, postmortem } from "@oh-my-pi/pi-utils";

let withdrawRegistered = false;

/** The registry directory of {@link sharedInstanceHost}. */
export function instanceRegistryDir(): string {
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
