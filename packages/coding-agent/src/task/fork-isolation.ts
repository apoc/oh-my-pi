import type { CreateAgentSessionOptions } from "../sdk";
import type { HostRestrictions } from "./host-restrictions";

/**
 * A host-requested read-only fork of a persisted session (mesh `ask` responders). The child starts
 * from a copy of `sourceFile`'s history, confined to it: `history://`, `agent://` and inherited `local://`
 * read the source's artifacts in place, and every subagent the fork spawns stays confined too.
 */
export interface SubagentFork {
	sourceFile: string;
	/** Settings forced off for the fork and every subagent under it. */
	hostRestrictions?: HostRestrictions;
}

/**
 * Session capabilities of a confined fork: restricted tools, no extensions/MCP/IRC/LSP, no inherited
 * project context.
 */
export function forkIsolationOptions(cwd: string) {
	return {
		disableExtensionDiscovery: true,
		restrictToolNames: true,
		enableMCP: false,
		mcpManager: undefined,
		mcpTools: [],
		enableIrc: false,
		enableLsp: false,
		additionalDirectories: [],
		inheritedSessionAgents: undefined,
		contextFiles: [],
		skills: [],
		workspaceTree: {
			rootPath: cwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		promptTemplates: [],
		rules: [],
		extensionRoots: undefined,
		preloadedExtensionPaths: [],
		preloadedPreparedExtensions: [],
		preloadedCustomToolPaths: [],
		customTools: undefined,
		localProtocolOptions: undefined,
		parentHindsightSessionState: undefined,
		parentMnemopiSessionState: undefined,
	} satisfies Partial<CreateAgentSessionOptions>;
}
