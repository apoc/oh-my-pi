/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

const INBOUND_OPTIONS = [
	{ value: "allow", label: "Allow", description: "Accept without asking" },
	{ value: "ask", label: "Ask", description: "Ask in the TUI; denied when no UI can ask" },
	{ value: "deny", label: "Deny", description: "Reject every request of this kind" },
] as const;

// Mesh
export const cfgMeshEnabled = register({
	id: "mesh.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Enable Mesh",
		description:
			"Discover other omp instances and exchange status/ask/steer messages with their main agents (xd://mesh_peers, xd://mesh_send, /mesh)",
	},
});

export const cfgMeshMode = register({
	id: "mesh.mode",
	type: "enum",
	values: ["local", "remote", "both"] as const,
	default: "local",
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Mode",
		description: "Which instances the mesh reaches",
		options: [
			{ value: "local", label: "Local", description: "Same PC, same user; no network listener" },
			{ value: "remote", label: "Remote", description: "Other machines on the LAN (mDNS); needs a key phrase" },
			{ value: "both", label: "Both", description: "Same PC and LAN; needs a key phrase for LAN peers" },
		],
	},
});

export const cfgMeshKey = register({
	id: "mesh.key",
	type: "string",
	default: "",
	credential: true,
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Mesh Key",
		description:
			"Key derived from the mesh key phrase (set it via /mesh or `omp mesh set-key`; the phrase is never stored)",
		secret: true,
	},
});

export const cfgMeshDisplayName = register({
	id: "mesh.displayName",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Display Name",
		description: "Name shown to mesh peers (default: collab.displayName, else user@host)",
	},
});

export const cfgMeshPort = register({
	id: "mesh.port",
	type: "number",
	default: 0,
	validate: raw => {
		if (raw === undefined) return;
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 65535) {
			throw new Error("mesh.port must be an integer from 0 to 65535");
		}
	},
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "LAN Port",
		description: "TCP port of the LAN listener; 0 picks a free port",
	},
});

export const cfgMeshPeers = register({
	id: "mesh.peers",
	type: "array",
	default: [] as readonly string[],
	validate: raw => {
		if (raw === undefined) return;
		if (!Array.isArray(raw) || raw.some(entry => typeof entry !== "string" || entry.trim().length === 0)) {
			throw new Error("mesh.peers must be a list of host:port strings");
		}
	},
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Static Peers",
		description: "host:port endpoints dialed directly when mDNS cannot reach them",
		editor: "json",
	},
});

export const cfgMeshSummary = register({
	id: "mesh.summary",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Session Summary",
		description: "Publish a short smol-model summary of what this session is about to mesh peers",
	},
});

export const cfgMeshInboundStatus = register({
	id: "mesh.inbound.status",
	type: "enum",
	values: ["allow", "ask", "deny"] as const,
	default: "allow",
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Inbound Status",
		description: "Status questions answered from the main context without tools",
		options: INBOUND_OPTIONS,
	},
});

export const cfgMeshInboundAsk = register({
	id: "mesh.inbound.ask",
	type: "enum",
	values: ["allow", "ask", "deny"] as const,
	default: "allow",
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Inbound Ask",
		description: "Questions answered by a read-only fork of the main session",
		options: INBOUND_OPTIONS,
	},
});

export const cfgMeshInboundSteer = register({
	id: "mesh.inbound.steer",
	type: "enum",
	values: ["allow", "ask", "deny"] as const,
	default: "ask",
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Inbound Steer",
		description: "Messages injected into the main agent's own conversation",
		options: INBOUND_OPTIONS,
	},
});

export const cfgMeshInboundTask = register({
	id: "mesh.inbound.task",
	type: "enum",
	values: ["allow", "ask", "deny"] as const,
	default: "deny",
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Inbound Task",
		description: "Remote task delegation: a subagent with write tools runs in this project",
		options: INBOUND_OPTIONS,
	},
});

export const cfgMeshInboundNote = register({
	id: "mesh.inbound.note",
	type: "enum",
	values: ["allow", "ask", "deny"] as const,
	default: "allow",
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Inbound Notes",
		description: "Human notes shown in this TUI (never sent to the agent)",
		options: INBOUND_OPTIONS,
	},
});

export const cfgMeshMaxConcurrentAsks = register({
	id: "mesh.maxConcurrentAsks",
	type: "number",
	default: 2,
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Max Concurrent Asks",
		description: "Forked responders (ask/task) running at once; further requests queue",
	},
});

export const cfgMeshThreadTtlHours = register({
	id: "mesh.threadTtlHours",
	type: "number",
	default: 24,
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Thread TTL (hours)",
		description: "Idle status/ask threads are forgotten after this many hours",
	},
});
