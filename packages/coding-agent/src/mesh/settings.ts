/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import * as os from "node:os";
import type { MeshConfig } from "@oh-my-pi/pi-natives";
import { cfgCollabDisplayName } from "../collab/settings";
import { type Derived, operatorValue, register, type ScopeLike } from "../config/registry";
import type { MeshMessageKind } from "./wire";

export type MeshInboundPolicy = "allow" | "ask" | "deny";

/**
 * A derived mesh key: 32 bytes as canonical unpadded base64url (`MeshKeys::load` in
 * `crates/mesh/src/keys.rs`), so the last of its 43 characters carries 2 zero padding bits.
 */
const MESH_KEY_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** Closing sentence of the description of every operator-only setting. */
const OPERATOR_ONLY = "Project settings cannot set this.";

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
		// Operator-only (read via the `cfgOperatorMesh*` values); the row hides while a project layer supplies it.
		condition: "notProject",
		label: "Enable Mesh",
		description: `Discover other omp instances and exchange status/ask/steer messages with their main agents (mesh_peers, mesh_send, /mesh). ${OPERATOR_ONLY}`,
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
		condition: "notProject",
		label: "Mode",
		description: `Which instances the mesh reaches. ${OPERATOR_ONLY}`,
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
	validate: raw => {
		if (raw === undefined || raw === "") return;
		if (typeof raw !== "string" || !MESH_KEY_PATTERN.test(raw)) {
			throw new Error(
				"mesh.key must be the derived key, not the key phrase: remove `mesh.key` from your config file, then set the phrase via /mesh or `omp mesh set-key`",
			);
		}
	},
	ui: {
		tab: "interaction",
		group: "Mesh",
		condition: "notProject",
		label: "Mesh Key",
		description: `Key derived from the mesh key phrase (set it via /mesh or \`omp mesh set-key\`; the phrase is never stored). ${OPERATOR_ONLY}`,
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
		condition: "notProject",
		label: "LAN Port",
		description: `TCP port of the LAN listener; 0 picks a free port. ${OPERATOR_ONLY}`,
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
		condition: "notProject",
		label: "Static Peers",
		description: `host:port endpoints dialed directly when mDNS cannot reach them. ${OPERATOR_ONLY}`,
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
		condition: "notProject",
		label: "Inbound Status",
		description: `Status questions answered from the main context without tools. ${OPERATOR_ONLY}`,
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
		condition: "notProject",
		label: "Inbound Ask",
		description: `Questions answered by a read-only fork of the main session. ${OPERATOR_ONLY}`,
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
		condition: "notProject",
		label: "Inbound Steer",
		description: `Messages injected into the main agent's own conversation. ${OPERATOR_ONLY}`,
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
		condition: "notProject",
		label: "Inbound Task",
		description: `Remote task delegation: a subagent with write tools runs in this project. ${OPERATOR_ONLY}`,
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
		condition: "notProject",
		label: "Inbound Notes",
		description: `Human notes shown in this TUI (never sent to the agent). ${OPERATOR_ONLY}`,
		options: INBOUND_OPTIONS,
	},
});

/*
 * The ten settings above that carry `condition: "notProject"` are ones a repository must
 * not control: a project layer could otherwise enable the mesh with a key it knows and accept
 * remote tasks (LAN code execution). Read them only through the operator values below; writes
 * (`/mesh`, `omp mesh set-key`) go to the global layer.
 */

/** `mesh.enabled` from operator layers only; whether the mesh runs. */
export const cfgOperatorMeshEnabled = operatorValue(cfgMeshEnabled);
/** `mesh.mode` from operator layers only. */
export const cfgOperatorMeshMode = operatorValue(cfgMeshMode);
/** `mesh.key` from operator layers only. */
export const cfgOperatorMeshKey = operatorValue(cfgMeshKey);
/** `mesh.port` from operator layers only. */
export const cfgOperatorMeshPort = operatorValue(cfgMeshPort);
/** `mesh.peers` from operator layers only. */
export const cfgOperatorMeshPeers = operatorValue(cfgMeshPeers);

/** `mesh.inbound.<kind>` per message kind, from operator layers only. */
export const cfgMeshInboundPolicy: Record<MeshMessageKind, Derived<MeshInboundPolicy>> = {
	status: operatorValue(cfgMeshInboundStatus),
	ask: operatorValue(cfgMeshInboundAsk),
	steer: operatorValue(cfgMeshInboundSteer),
	task: operatorValue(cfgMeshInboundTask),
	note: operatorValue(cfgMeshInboundNote),
};

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

export const cfgMeshAnnouncePeers = register({
	id: "mesh.announcePeers",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Announce Peers",
		description: "Tell the agent which other agents are on the mesh and when they appear or leave",
	},
});

export const cfgMeshAutoBackgroundEnabled = register({
	id: "mesh.autoBackground.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Mesh",
		label: "Auto-Background Asks",
		description: "Move unanswered status/ask/task waits to a background job; the answer wakes the agent later",
	},
});

export const cfgMeshAutoBackgroundThresholdMs = register({
	id: "mesh.autoBackground.thresholdMs",
	type: "number",
	default: 10_000,
});

/** Display name peers see: `mesh.displayName`, else `collab.displayName`, else `user@host`. */
function resolveMeshDisplayName(settings: ScopeLike): string {
	const configured = cfgMeshDisplayName.get(settings).trim() || cfgCollabDisplayName.get(settings).trim();
	if (configured) return configured;
	try {
		return `${os.userInfo().username}@${os.hostname()}`;
	} catch {
		return os.hostname();
	}
}

/** Engine configuration for the operator's `mesh.*` settings (mesh assumed enabled). */
export function meshConfigFromSettings(settings: ScopeLike): MeshConfig {
	const key = cfgOperatorMeshKey.get(settings).trim();
	const deniedKinds = (Object.keys(cfgMeshInboundPolicy) as MeshMessageKind[]).filter(
		kind => cfgMeshInboundPolicy[kind].get(settings) === "deny",
	);
	return {
		mode: cfgOperatorMeshMode.get(settings),
		key: key || undefined,
		lanPort: cfgOperatorMeshPort.get(settings),
		staticPeers: [...cfgOperatorMeshPeers.get(settings)],
		displayName: resolveMeshDisplayName(settings),
		deniedKinds,
	};
}
