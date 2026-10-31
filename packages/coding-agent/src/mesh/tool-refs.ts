/**
 * Which sessions get the mesh's model-facing surfaces (`mesh_peers`, `mesh_send`, `mesh://`) and
 * how prompts name the tools. Kept free of the tool and judge stacks so the bridge, the router and
 * the tools can all import it.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { XD_URL_PREFIX } from "@oh-my-pi/pi-tui/tools/xd-url";
import type { ToolSession } from "../tools";
import { getMeshRuntime, type MeshRuntime } from "./runtime";
import { cfgMeshEnabled } from "./settings";

export type MeshToolName = "mesh_peers" | "mesh_send";

export type MeshToolSession = Pick<ToolSession, "settings" | "taskDepth" | "sessionManager">;

/**
 * The mesh surfaces belong to the top-level session the running mesh runtime is bound to, while
 * `mesh.enabled`: subagents, mesh responders, other ACP sessions and hosts that never start the
 * mesh (print mode, SDK) never get them.
 */
export function isMeshToolSession(session: MeshToolSession): boolean {
	if (!cfgMeshEnabled.get(session.settings) || (session.taskDepth ?? 0) !== 0) return false;
	const bound = getMeshRuntime()?.session.sessionManager;
	return bound !== undefined && bound === session.sessionManager;
}

/** The runtime for `session`, or a tool error when the mesh is off or serves another session. */
export function requireMeshRuntime(session: MeshToolSession | undefined): MeshRuntime {
	const runtime = getMeshRuntime();
	if (!runtime) {
		throw new ToolError("Mesh is not running in this process (mesh.enabled is off or the host did not start it).");
	}
	if (!session || !isMeshToolSession(session)) {
		throw new ToolError("The mesh is available to the top-level session it serves only.");
	}
	return runtime;
}

/** Prompt references for the mesh tools: `xd://<name>` when mounted as a device, else the bare name. */
export function meshToolRefs(session: Pick<ToolSession, "xdev">): Record<MeshToolName, string> {
	const mounted = session.xdev?.mountedNames;
	return {
		mesh_peers: mounted?.has("mesh_peers") ? `${XD_URL_PREFIX}mesh_peers` : "mesh_peers",
		mesh_send: mounted?.has("mesh_send") ? `${XD_URL_PREFIX}mesh_send` : "mesh_send",
	};
}
