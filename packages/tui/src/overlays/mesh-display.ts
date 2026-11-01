/**
 * Pure display helpers for mesh peer data, shared by the `/mesh` manager, transcript cards and
 * the coding agent's mesh UI. Peer-supplied strings are untrusted; these make them safe to render.
 */
import { stripBidiControls } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./extensions/display-text";
import type { MeshComposeKind, MeshManagerMode, MeshManagerPeer } from "./mesh-manager-types";

/** A peer-supplied string as one safe display line; empty when missing. Bidi controls go first so no whitespace they framed survives. */
export function meshDisplayText(text: string | null | undefined): string {
	return typeof text === "string" && text.length > 0 ? sanitizeDisplayLine(stripBidiControls(text)) : "";
}

/** A peer-supplied multi-line text (summary, note, reply), safe to render; empty when missing. */
export function meshDisplayBlock(text: string | null | undefined): string {
	return typeof text === "string" && text.length > 0 ? sanitizeDisplayText(stripBidiControls(text)).trim() : "";
}

/** Whether `mode` reaches peers of the `local` / `remote` side. */
export function meshModeHasSide(mode: MeshManagerMode, side: "local" | "remote"): boolean {
	return mode === "both" || mode === side;
}

/** Counts for the status line: visible, unblocked, online peers per side. */
export function countMeshPeers(peers: readonly MeshManagerPeer[]): { local: number; remote: number } {
	let local = 0;
	let remote = 0;
	for (const peer of peers) {
		if (peer.hidden || peer.blocked || peer.state !== "online") continue;
		if (peer.endpointKind === "local") local++;
		else remote++;
	}
	return { local, remote };
}

/** Why `kind` cannot be sent to `peer`, or undefined when it can: a blocked peer's answers never arrive. */
export function meshComposeRefusal(peer: MeshManagerPeer, kind: MeshComposeKind): string | undefined {
	if (!peer.blocked || kind === "note") return undefined;
	return `${peer.displayName} is blocked, so its answer could never arrive. Unblock it (b) or send a note.`;
}

/** `name@host`, or `name` alone when it already ends with `@host` (default display names are `user@host`). */
export function meshSenderLabel(name: string, host: string): string {
	return host && !name.endsWith(`@${host}`) ? `${name}@${host}` : name;
}
