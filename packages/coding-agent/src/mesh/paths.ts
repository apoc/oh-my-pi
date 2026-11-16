/**
 * On-disk layout of mesh data inside a session's artifacts dir.
 */
import * as path from "node:path";
import { MESH_THREADS_DIRNAME } from "../internal-urls/registry-helpers";

/** Persistent artifacts root of one thread's responders (transcripts, outputs). */
export function meshResponderArtifactsDir(artifactsDir: string, threadId: string): string {
	return path.join(artifactsDir, MESH_THREADS_DIRNAME, "responders", threadId);
}

/**
 * Whether a responder transcript at `sessionFile` belongs to `threadId`. Responder ids restart after
 * a process restart (they are allocated from the top-level artifacts dir only), so a reloaded thread
 * must not continue an id now held by another thread's responder.
 */
export function isMeshThreadResponder(
	sessionFile: string | null | undefined,
	artifactsDir: string,
	threadId: string,
): boolean {
	if (!sessionFile) return false;
	return path.resolve(path.dirname(sessionFile)) === path.resolve(meshResponderArtifactsDir(artifactsDir, threadId));
}
