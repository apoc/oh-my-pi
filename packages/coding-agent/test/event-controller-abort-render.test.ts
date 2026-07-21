/**
 * Phase 6 — C layer.
 *
 * Asserts `EventController.#handleMessageEnd`'s render labeling for the three
 * abort-classification paths:
 *
 *   C1  errorMessage = SILENT_ABORT_MARKER + aborted
 *       → `updateContent` receives a message with `stopReason: "stop"`;
 *         `errorMessage` is NOT overwritten.
 *   C2  errorMessage = undefined (no threaded reason) + aborted + no TTSR flag
 *       → `streamingMessage.errorMessage` is set to the generic "Operation
 *         aborted"; `updateContent` receives the original message ref.
 *   C2b errorMessage = USER_INTERRUPT_LABEL (threaded via AbortController) + aborted
 *       → the threaded reason is preserved verbatim, NOT replaced by the generic.
 *   C3  isTtsrAbortPending = true + aborted
 *       → `updateContent` receives a message with `stopReason: "stop"`;
 *         `errorMessage` is NOT set (TTSR existing behavior unchanged).
 *
 * Implementation note: `AssistantMessageComponent.prototype.updateContent` is
 * replaced with a spy so the TUI rendering stack (theme, settings, markdown) is
 * never invoked. This makes `#lastMessage` stay unset, which prevents the
 * indirect re-calls from `setContentRange` / `setIsFinalSegment` / `setUsageInfo`.
 * The only explicit calls are: (0) from `startMessage`, (1) from `finalize` — the
 * latter carries the `renderableMessage` the tests assert on.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SILENT_ABORT_MARKER, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "aborted",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

function createFixture(opts: { isTtsrAbortPending?: boolean; retryAttempt?: number }) {
	const chatContainer = { addChild: vi.fn(), removeChild: vi.fn() };
	const requestRender = vi.fn();

	const ctxBase = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		chatContainer,
		hideThinkingBlock: false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		settings: { get: () => false },
		noteDisplayableThinkingContent: vi.fn(() => false),
	};
	const sessionMock = {
		isTtsrAbortPending: opts.isTtsrAbortPending ?? false,
		retryAttempt: opts.retryAttempt ?? 0,
	};
	const ctx = {
		...ctxBase,
		session: sessionMock,
		viewSession: sessionMock,
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, ctx };
}

/**
 * Initialise the segment builder (via `message_start`) with rendering mocked out,
 * then return a spy that captures only the calls made during `message_end`.
 */
async function initStream(
	controller: EventController,
	_ctx: InteractiveModeContext,
	message: AssistantMessage,
): Promise<Mock<(message: AssistantMessage) => void>> {
	// Replace updateContent on the prototype so AssistantMessageComponent can be
	// constructed and `startMessage` can run without the theme/settings stack.
	// Because `#lastMessage` is never set by this mock, the indirect re-calls from
	// setContentRange / setIsFinalSegment / setUsageInfo are suppressed.
	const spy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent").mockImplementation(() => {});
	await controller.handleEvent({
		type: "message_start",
		message,
	} as Extract<AgentSessionEvent, { type: "message_start" }>);
	spy.mockClear(); // discard the call from startMessage — only message_end calls matter
	return spy;
}

describe("EventController #handleMessageEnd abort labeling", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});
	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("C1: SILENT_ABORT_MARKER + aborted -> updateContent stopReason='stop', errorMessage NOT overwritten", async () => {
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
		});
		const { controller, ctx } = createFixture({});
		const updateContentSpy = await initStream(controller, ctx, message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		// `finalize` calls `updateContent` exactly once with the renderable copy.
		expect(updateContentSpy).toHaveBeenCalledTimes(1);
		const arg = updateContentSpy.mock.calls[0]![0] as AssistantMessage;
		expect(arg.stopReason).toBe("stop");
		expect(arg.errorMessage).toBe(SILENT_ABORT_MARKER);

		// The controller must NOT overwrite errorMessage on the persisted message.
		expect(message.errorMessage).toBe(SILENT_ABORT_MARKER);
		expect(ctx.streamingMessage).toBeUndefined();
	});

	it("C1b: silent-abort errorId without marker suppresses the abort line", async () => {
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: undefined,
			errorId: AIError.create(AIError.Flag.SilentAbort),
		});
		const { controller, ctx } = createFixture({});
		const updateContentSpy = await initStream(controller, ctx, message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(message.errorMessage).toBeUndefined();
		expect(updateContentSpy).toHaveBeenCalledTimes(1);
		const arg = updateContentSpy.mock.calls[0]![0] as AssistantMessage;
		expect(arg.stopReason).toBe("stop");
		expect(arg.errorMessage).toBeUndefined();
	});

	it("C2: errorMessage undefined (no threaded reason) + aborted + no TTSR -> errorMessage='Operation aborted', updateContent receives original ref", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: undefined });
		const { controller, ctx } = createFixture({ isTtsrAbortPending: false });
		const updateContentSpy = await initStream(controller, ctx, message);

		await controller.handleEvent({ type: "message_end", message });

		// No threaded reason -> generic operator-facing label stamped in-place.
		expect(message.errorMessage).toBe("Operation aborted");

		// `finalize` receives the original ref — no stopReason-cleared copy.
		expect(updateContentSpy).toHaveBeenCalledTimes(1);
		const arg = updateContentSpy.mock.calls[0]![0] as AssistantMessage;
		expect(arg).toBe(message);
		expect(arg.stopReason).toBe("aborted");
		expect(arg.errorMessage).toBe("Operation aborted");
	});

	it("C2b: threaded user-interrupt reason on aborted message is preserved, not replaced by the generic label", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: USER_INTERRUPT_LABEL });
		const { controller, ctx } = createFixture({ isTtsrAbortPending: false });
		const updateContentSpy = await initStream(controller, ctx, message);

		await controller.handleEvent({ type: "message_end", message });

		// The Esc-interrupt reason rode the AbortController onto errorMessage; the
		// controller must surface it verbatim instead of overwriting with "Operation aborted".
		expect(message.errorMessage).toBe(USER_INTERRUPT_LABEL);
		const arg = updateContentSpy.mock.calls[0]![0] as AssistantMessage;
		expect(arg.errorMessage).toBe(USER_INTERRUPT_LABEL);
		expect(arg.stopReason).toBe("aborted");
	});

	it("C3: isTtsrAbortPending=true + aborted -> updateContent stopReason='stop', errorMessage NOT set", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: undefined });
		const { controller, ctx } = createFixture({ isTtsrAbortPending: true });
		const updateContentSpy = await initStream(controller, ctx, message);

		await controller.handleEvent({ type: "message_end", message });

		expect(message.errorMessage).toBeUndefined();
		expect(updateContentSpy).toHaveBeenCalledTimes(1);
		const arg = updateContentSpy.mock.calls[0]![0] as AssistantMessage;
		expect(arg.stopReason).toBe("stop");
		expect(arg.errorMessage).toBeUndefined();
	});
});
