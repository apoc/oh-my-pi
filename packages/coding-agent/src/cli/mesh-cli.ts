/**
 * CLI handlers for `omp mesh`: store the mesh key derived from a key phrase, and list the peers a
 * short-lived engine discovers with the current settings.
 */
import * as os from "node:os";
import { meshDeriveKey } from "@oh-my-pi/pi-natives";
import { formatAge } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { MESH_MIN_KEY_PHRASE_CHARS, meshDisplayText } from "@oh-my-pi/pi-tui/overlays/mesh-manager";
import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { Settings } from "../config/settings";
import type { MeshPeerView } from "../mesh/engine";
import { meshConfigFromSettings, resolveMeshDisplayName } from "../mesh/host";
import { NativeMeshEngine } from "../mesh/native-engine";
import { formatMeshEndpoint, MESH_DISCOVERY_WINDOW_MS } from "../mesh/peers";
import { cfgMeshEnabled, cfgMeshKey } from "../mesh/settings";

/** Summary line cap when stdout is not a terminal. */
const SUMMARY_LINE_CHARS = 200;

export interface MeshListCommandArgs {
	json: boolean;
}

/**
 * Prompt for the key phrase, derive the mesh key and store it in the global config. The key is
 * never printed. The phrase is checked (derivation rejects blank and too-short phrases) before
 * the confirmation prompt, so a rejected phrase is never typed twice.
 */
export async function runMeshSetKeyCommand(): Promise<void> {
	const tty = process.stdin.isTTY;
	const phrase = tty ? await promptHidden("Mesh key phrase: ") : ((await Bun.stdin.text()).split(/\r?\n/, 1)[0] ?? "");
	const key = await meshDeriveKey(phrase);
	const length = [...phrase.trim()].length;
	if (length < MESH_MIN_KEY_PHRASE_CHARS) {
		process.stderr.write(
			chalk.yellow(
				`warning: key phrase has ${length} characters; use at least ${MESH_MIN_KEY_PHRASE_CHARS} so LAN peers cannot guess it.\n`,
			),
		);
	}
	if (tty && (await promptHidden("Repeat key phrase: ")) !== phrase) {
		throw new Error("Key phrases do not match; nothing stored.");
	}
	const settings = await Settings.init();
	cfgMeshKey.set(settings, key);
	await settings.flush();
	console.log(chalk.green("Mesh key stored. Use the same phrase on every machine that should join this mesh."));
}

/** Run a transient engine for {@link MESH_DISCOVERY_WINDOW_MS} with the current settings and print what it found. */
export async function runMeshListCommand(args: MeshListCommandArgs): Promise<void> {
	const settings = await Settings.init();
	const config = meshConfigFromSettings(settings);
	const engine = new NativeMeshEngine({ displayName: resolveMeshDisplayName(settings), host: os.hostname() });
	let peers: MeshPeerView[];
	try {
		// Discovery needs no stable inbound port; a fixed `mesh.port` is held by a running instance.
		const status = await engine.configure({ ...config, lanPort: 0 });
		engine.refresh();
		await Bun.sleep(MESH_DISCOVERY_WINDOW_MS);
		peers = engine.peers().filter(peer => !peer.blocked);
		if (args.json) {
			console.log(JSON.stringify({ status, peers }, null, 2));
			return;
		}
		if (!cfgMeshEnabled.get(settings)) {
			console.log(chalk.dim("mesh.enabled is off: this instance does not join the mesh, listing anyway."));
		}
		if (status.error) console.log(chalk.yellow(`engine: ${meshDisplayText(status.error)}`));
		console.log(chalk.dim(`mode ${status.mode} · local ${status.local} · remote ${status.remote}`));
	} finally {
		await engine.close();
	}
	if (peers.length === 0) {
		console.log(chalk.dim("No mesh peers found."));
		return;
	}
	console.log(chalk.green(`${peers.length} mesh ${peers.length === 1 ? "peer" : "peers"}`));
	const now = Date.now();
	// One summary line per peer: the terminal width when attached, else a fixed cap for pipes/logs.
	const summaryWidth = process.stdout.isTTY ? Math.max(20, (process.stdout.columns ?? 80) - 2) : SUMMARY_LINE_CHARS;
	for (const peer of peers) {
		const snapshot = peer.snapshot;
		// meshDisplayText strips bidi controls before sanitizing: peer names must not reorder the terminal line.
		const name = snapshot ? meshDisplayText(snapshot.displayName) : "(no snapshot yet)";
		const session = meshDisplayText(snapshot?.sessionName);
		const details = [meshDisplayText(formatMeshEndpoint(peer))];
		if (peer.source !== "local") details.push(`via ${peer.source}`);
		details.push(peer.state, `seen ${formatAge(Math.round((now - peer.lastSeen) / 1000)) || "just now"}`);
		if (snapshot) {
			details.push(`host ${meshDisplayText(snapshot.host)}`, `pid ${snapshot.pid}`);
			details.push(snapshot.busy ? "working" : "idle");
			if (snapshot.model) details.push(meshDisplayText(snapshot.model));
		}
		if (peer.hidden) details.push("hidden");
		console.log("");
		console.log(`${peer.instanceId}  ${name}${session ? `  ${session}` : ""}`);
		if (snapshot) console.log(`  ${chalk.dim(meshDisplayText(shortenPath(snapshot.cwd)))}`);
		if (snapshot?.summary) console.log(`  ${truncateToWidth(meshDisplayText(snapshot.summary.text), summaryWidth)}`);
		console.log(`  ${chalk.dim(details.join(" · "))}`);
	}
}

/** Read one line from the TTY without echoing it (each character shows as `*`). */
function promptHidden(question: string): Promise<string> {
	const input = process.stdin;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let value = "";
	const finish = (error?: Error) => {
		input.off("data", onData);
		input.setRawMode(false);
		input.pause();
		process.stderr.write("\n");
		if (error) reject(error);
		else resolve(value);
	};
	const onData = (chunk: Buffer) => {
		for (const char of chunk.toString("utf8")) {
			if (char === "\r" || char === "\n") return finish();
			if (char === "\u0003" || char === "\u0004") return finish(new Error("Cancelled; nothing stored."));
			// Escape sequences (arrow keys, focus reports) are not phrase input: drop the rest of the chunk.
			if (char === "\u001b") return;
			if (char === "\u007f" || char === "\b") {
				if (value) {
					value = [...value].slice(0, -1).join("");
					process.stderr.write("\b \b");
				}
			} else if (char >= " ") {
				value += char;
				process.stderr.write("*");
			}
		}
	};
	process.stderr.write(question);
	input.setRawMode(true);
	input.on("data", onData);
	input.resume();
	return promise;
}
