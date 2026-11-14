/**
 * Process-wide signal that the availability of gated built-in tools changed (a feature whose tools
 * are offered only while some runtime state holds has just gained or lost that state). Sessions
 * listen to refresh their tool set; the feature signals after its state changes.
 */

const listeners = new Set<() => void>();

/** Follows gated-tool availability changes; returns the unsubscriber. */
export function onGatedToolsChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Tells every listener that gated-tool availability may have changed. */
export function signalGatedToolsChanged(): void {
	for (const listener of listeners) listener();
}
