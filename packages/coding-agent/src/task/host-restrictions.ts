/**
 * Host restrictions: settings a seance fork forces off for its whole subagent tree (mesh `ask`
 * responders turn off URL fetching and web search). Every descendant inherits them, warm revival keeps
 * them, and nothing in the tree can turn them back on. They are never persisted: a fork's tree is
 * seance-confined, and cold revival never restores a confined non-seance agent.
 */
type HostRestrictionKey = "fetch.enabled" | "web_search.enabled";

/** Settings forced to `false` for a subagent tree. */
export type HostRestrictions = Readonly<Partial<Record<HostRestrictionKey, false>>>;

/** `parent` plus `own`; undefined when neither restricts anything. */
export function mergeHostRestrictions(
	parent: HostRestrictions | undefined,
	own: HostRestrictions | undefined,
): HostRestrictions | undefined {
	const merged = { ...parent, ...own };
	return Object.keys(merged).length > 0 ? merged : undefined;
}
