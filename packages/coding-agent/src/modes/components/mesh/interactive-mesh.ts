/**
 * The interactive TUI's whole mesh surface behind one object: the host serving the main session, the
 * `mesh` status-line segment, the `/mesh ask|steer` controller and the fullscreen manager overlay.
 */
import { MeshManagerComponent } from "@oh-my-pi/pi-tui/overlays/mesh-manager";
import { type MeshHostHandle, startMeshHost } from "../../../mesh/host";
import { MeshAskController } from "../../controllers/mesh-ask-controller";
import type { SelectorController } from "../../controllers/selector-controller";
import type { InteractiveModeContext } from "../../types";
import { attachMeshStatusLine, createMeshManagerRuntime } from "./mesh-manager-runtime";
import { createTuiMeshUiHooks } from "./mesh-ui-hooks";

/** Single-instance fullscreen menus the manager overlay mounts through. */
export type FullscreenMenus = Pick<SelectorController, "openFullscreenMenu">;

export class InteractiveMesh {
	readonly #ctx: InteractiveModeContext;
	readonly #menus: FullscreenMenus;
	readonly #ask: MeshAskController;
	readonly #detachStatusLine: () => void;
	readonly #host: MeshHostHandle;
	#disposed: Promise<void> | undefined;

	constructor(ctx: InteractiveModeContext, menus: FullscreenMenus) {
		this.#ctx = ctx;
		this.#menus = menus;
		this.#ask = new MeshAskController(ctx);
		this.#detachStatusLine = attachMeshStatusLine(ctx.settings, (key, text) => ctx.setHookStatus(key, text));
		this.#host = startMeshHost({ session: ctx.session, ui: createTuiMeshUiHooks(ctx) });
	}

	/** Open the fullscreen `/mesh` manager: approvals, local/remote peers, mode, key phrase and compose. */
	showManager(): void {
		this.#menus.openFullscreenMenu(
			"mesh-manager",
			close =>
				new MeshManagerComponent(createMeshManagerRuntime(this.#ctx.settings), {
					requestRender: () => this.#ctx.ui.requestRender(),
					rows: () => this.#ctx.ui.terminal.rows,
					onClose: close,
					onAsk: instanceId => this.openAsk(instanceId),
				}),
		);
	}

	/** `/mesh ask [peer [message]]`: no message opens the conversation dialog. False: nothing sent or opened. */
	ask(args: string): Promise<boolean> {
		return this.#ask.handleCommand(args);
	}

	/** `/mesh steer [peer [message]]`: steer a mesh agent's main session. False: nothing sent. */
	steer(args: string): Promise<boolean> {
		return this.#ask.handleSteerCommand(args);
	}

	/** Open the `/mesh ask` conversation dialog with one mesh peer. */
	openAsk(instanceId: string): void {
		this.#ask.openForPeer(instanceId);
	}

	/** Leave the mesh, then drop the status segment and the ask dialogs; repeat calls share the first. */
	dispose(): Promise<void> {
		this.#disposed ??= this.#dispose();
		return this.#disposed;
	}

	async #dispose(): Promise<void> {
		await this.#host.dispose();
		this.#detachStatusLine();
		this.#ask.dispose();
	}
}

/** Attach the mesh status line, then start the host for the main session. */
export function installMesh(ctx: InteractiveModeContext, menus: FullscreenMenus): InteractiveMesh {
	return new InteractiveMesh(ctx, menus);
}
