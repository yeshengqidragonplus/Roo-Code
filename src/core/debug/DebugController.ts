import { debugMode } from "./debugMode"
import { DebugPanelProvider } from "./DebugPanelProvider"

/**
 * Where in the agent loop a breakpoint fired.
 *
 * - `beforeRequest`: just before `api.createMessage` — full outbound payload
 *   (system prompt + messages + metadata) is available.
 * - `afterResponse`: right after the stream is fully read — the model's full
 *   reply text is available. This is the only breakpoint that fires for a
 *   plain-text reply (no tool call).
 * - `beforeTool`: just before a (complete) tool executes inside
 *   presentAssistantMessage — the model has decided what to do and is about to
 *   act.
 *
 * NOTE: this fork streams the response and executes tools INLINE during the
 * stream, so a tool that streamed to completion may already have run (and hit
 * its own `beforeTool` breakpoint) before `afterResponse` fires. See
 * docs/debug-mode-design.md.
 */
export type DebugStage = "beforeRequest" | "afterResponse" | "beforeTool"

export interface DebugPausePayload {
	stage: DebugStage
	taskId: string
	systemPrompt?: string
	messages?: unknown
	metadata?: unknown
	assistantText?: string
	tool?: { name: string; input: unknown }
}

/**
 * Result handed back to the agent loop when a breakpoint resumes. Phase 3 is
 * read-only (continue only); phase 4 will populate the optional edited fields.
 */
export interface DebugResumeResult {
	systemPrompt?: string
	messages?: unknown
	metadata?: unknown
	assistantText?: string
	/** Edited tool call (beforeTool). Only `input` is applied to the run. */
	tool?: { name?: string; input?: unknown }
}

/**
 * Coordinates single-step debugging of the agent loop. When debug mode is off,
 * `pause()` returns immediately (zero overhead). When on, it pushes the payload
 * to the debug panel and blocks until the user resumes.
 *
 * See docs/debug-mode-design.md.
 */
class DebugController {
	private pending?: (result: DebugResumeResult) => void

	public isEnabled(): boolean {
		return debugMode.isEnabled()
	}

	/**
	 * Block the agent loop at a breakpoint until the user resumes. Returns the
	 * (possibly edited) values to use going forward. No-op + immediate return
	 * when debug mode is off or the panel isn't open.
	 */
	public async pause(payload: DebugPausePayload): Promise<DebugResumeResult> {
		if (!debugMode.isEnabled()) {
			return {}
		}

		const panel = DebugPanelProvider.instance
		if (!panel) {
			return {}
		}

		// Only one breakpoint can be pending at a time (the loop is sequential).
		// If somehow another is already pending, release it first to avoid a deadlock.
		this.pending?.({})

		return new Promise<DebugResumeResult>((resolve) => {
			this.pending = resolve
			panel.postMessage({ type: "debugPaused", payload })
		})
	}

	/** Resume the currently-paused breakpoint with optional edits. */
	public resume(result: DebugResumeResult = {}): void {
		const resolve = this.pending
		this.pending = undefined
		resolve?.(result)
		DebugPanelProvider.instance?.postMessage({ type: "debugResumed" })
	}

	/** Release any pending breakpoint without edits (e.g. on leaving debug mode). */
	public cancelAll(): void {
		const resolve = this.pending
		this.pending = undefined
		resolve?.({})
	}
}

/** Process-wide singleton. */
export const debugController = new DebugController()
