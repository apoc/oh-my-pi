import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { meshDisplayText } from "@oh-my-pi/pi-tui/overlays/mesh-display";
import type { MeshPeerView } from "../mesh/engine";
import { visibleMeshPeers } from "../mesh/peers";
import { getMeshRuntime } from "../mesh/runtime";
import { cfgMeshEnabled } from "../mesh/settings";
import { meshPeerCountsText } from "../modes/components/mesh/mesh-manager-runtime";
import { buildArgumentCompletions } from "./builtin-completions";
import { clearSubmittedText, refuseImages, restoreDetachedDraft, runWithDetachedDraft } from "./helpers/draft";
import { parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec, SubcommandDef } from "./types";

/** Listed peers of the running mesh, or none while it is off. */
function currentMeshPeers(): readonly MeshPeerView[] {
	const runtime = getMeshRuntime();
	return runtime ? visibleMeshPeers(runtime.engine) : [];
}

/**
 * `/mesh [ask|steer] <agent>`: the subcommand completes while typed (the bare `/mesh` opens the
 * manager), then mesh peers matched by session name, display name or instance id. The session
 * name is shown so the agent is easy to pick; the inserted value is the instance id, which always
 * resolves to exactly that peer (names repeat and may hold spaces or glyphs). The message after
 * the agent is free text.
 */
export function buildMeshArgumentCompletions(
	subcommands: SubcommandDef[],
	getPeers: () => readonly MeshPeerView[] = currentMeshPeers,
): (argumentPrefix: string) => AutocompleteItem[] | null {
	const subcommandCompletions = buildArgumentCompletions(subcommands, { optional: true });
	return (argumentPrefix: string) => {
		const spaceIndex = argumentPrefix.indexOf(" ");
		if (spaceIndex === -1) return subcommandCompletions(argumentPrefix);
		const rawSubcommand = argumentPrefix.slice(0, spaceIndex);
		if (!subcommands.some(sub => sub.name === rawSubcommand.toLowerCase())) return null;
		const peerPrefix = argumentPrefix.slice(spaceIndex + 1);
		if (/\s/.test(peerPrefix)) return null;
		const query = peerPrefix.toLowerCase();
		const matches: AutocompleteItem[] = [];
		for (const peer of getPeers()) {
			const snapshot = peer.snapshot;
			if (!snapshot) continue;
			const sessionName = snapshot.sessionName ?? "";
			if (
				query &&
				!peer.instanceId.toLowerCase().includes(query) &&
				!snapshot.displayName.toLowerCase().includes(query) &&
				!sessionName.toLowerCase().includes(query)
			) {
				continue;
			}
			const name = meshDisplayText(snapshot.displayName);
			const details = [name, peer.instanceId.slice(0, 8), snapshot.busy ? "busy" : "idle"];
			if (snapshot.repo?.branch) details.push(meshDisplayText(snapshot.repo.branch));
			matches.push({
				value: `${rawSubcommand} ${peer.instanceId} `,
				label: meshDisplayText(sessionName) || name,
				description: details.join(" · "),
			});
		}
		return matches.length > 0 ? matches : null;
	};
}

export const BUILTIN_MESH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "mesh",
		icon: "globe",
		description: "Manage the omp mesh: peers, approvals, mode, key phrase and messages",
		subcommands: [
			{ name: "ask", description: "Ask a mesh agent in a /btw-style dialog", usage: "[agent] [message]" },
			{ name: "steer", description: "Steer a mesh agent's main session", usage: "[agent] [message]" },
		],
		subcommandOptional: true,
		allowArgs: true,
		createArgumentCompletions: subcommands => buildMeshArgumentCompletions(subcommands),
		getTuiAutocompleteDescription: runtime => {
			if (!cfgMeshEnabled.get(runtime.ctx.settings)) return "Mesh: disabled (open and press e to enable)";
			const counts = meshPeerCountsText(runtime.ctx.settings, getMeshRuntime());
			return counts === undefined ? "Mesh: not running" : `Mesh: ${counts}`;
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			const mesh = ctx.mesh;
			const { verb, rest } = parseSubcommand(command.args);
			if (!mesh || (verb && verb !== "ask" && verb !== "steer")) {
				ctx.showError(
					mesh
						? "Usage: /mesh [ask|steer] [agent] [message]"
						: "The mesh is still starting; try again in a moment.",
				);
				// A detached draft already left the editor: give the command back, images included.
				if (runtime.draftDetached) {
					restoreDetachedDraft(ctx.editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
				}
				return;
			}
			if (!verb) {
				clearSubmittedText(runtime);
				mesh.showManager();
				return;
			}
			// Mesh messages carry text only.
			if (refuseImages(command, runtime)) return;
			const run = verb === "ask" ? () => mesh.ask(rest) : () => mesh.steer(rest);
			await runWithDetachedDraft(command, runtime, run, { restoreText: true });
		},
	},
];
