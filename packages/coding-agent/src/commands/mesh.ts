/**
 * Mesh setup and discovery from the shell.
 */
import { toError } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { meshHelp as commandHelp } from "../cli/command-help";
import { runMeshListCommand, runMeshSetKeyCommand } from "../cli/mesh-cli";

export default class Mesh extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default) or set-key",
			required: false,
			options: ["list", "set-key"],
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON (list only)", default: false }),
	};

	static examples = ["omp mesh list", "omp mesh list --json", "omp mesh set-key", "echo phrase | omp mesh set-key"];

	async run(): Promise<void> {
		const { args, argv, flags } = await this.parse(Mesh);
		if (argv.length > 1) throw new CliUsageError("mesh accepts one action (usage: mesh [list|set-key] [--json])");
		if ((args.action ?? "list") === "list") {
			await runMeshListCommand({ json: flags.json });
			return;
		}
		if (flags.json) throw new CliUsageError("mesh set-key accepts no --json");
		try {
			await runMeshSetKeyCommand();
		} catch (error) {
			process.stderr.write(`error: ${toError(error).message}\n`);
			process.exitCode = 1;
		}
	}
}
