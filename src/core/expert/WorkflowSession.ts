import type { WorkflowEngine, WorkflowState, WorkflowStep } from "@roo-code/types"

/**
 * Host-side workflow session for a type-A (workflow) expert.
 *
 * The expert (Task loop) is the master; this session is consulted to obtain the
 * next step's prompt. A model `attempt_completion` marks a STEP (workflow node)
 * boundary: its result is fed to `advance()`, the workflow moves to the next
 * node, and the expert continues toward the larger goal. The whole task is
 * truly done only when `advance()`/`start()` reports `done` (the workflow
 * terminal). See docs/expert-system-design.md §7.
 *
 * - Phase 1: soft steps (`nextPrompt`).
 * - Phase 2: hard `delegate` action — surfaced on `turn.delegate` so the host
 *   can spawn a sub-expert, then feed its summary back via `advance()`.
 * - Phase 3: hard `tool`/`skill` actions — surfaced on `turn.action` so the
 *   host can mechanically execute them (no LLM turn) and feed the result back
 *   via `advance()`. See docs/workflow-phase3-plan.md.
 */

/** Dependencies injected so the orchestration is testable in isolation. */
export interface WorkflowSessionDeps {
	/** Load + parse the workflow graph by id and build a contract WorkflowEngine. */
	createEngine: (workflowId: string) => Promise<WorkflowEngine>
	/** Persist the engine state for this session (per conversation). */
	persist: (workflowId: string, state: WorkflowState) => Promise<void>
}

/** A hard tool/skill directive the host executes mechanically (no LLM turn). */
export type WorkflowHardAction =
	| { type: "tool"; name: string; params?: Record<string, unknown> }
	| { type: "skill"; name: string; args?: Record<string, unknown> }

/** The outcome of a session step the Task loop acts on. */
export interface WorkflowTurn {
	/** Prompt to inject for the next LLM step (undefined when done). */
	prompt?: string
	/**
	 * Hard delegate directive: the host must spawn the named sub-expert with this
	 * goal, then feed the child's summary back into `advance()` to continue.
	 * Exactly one of `prompt` / `delegate` / `action` is set on a non-done turn.
	 */
	delegate?: { expert: string; goal: string }
	/**
	 * Hard tool/skill directive (Phase 3): the host must mechanically execute
	 * this tool/skill (no LLM turn), then feed the result text back into
	 * `advance()` to continue. Exactly one of `prompt` / `delegate` / `action`
	 * is set on a non-done turn.
	 */
	action?: WorkflowHardAction
	/** True when the whole workflow has finished. */
	done: boolean
	/** Final result summary when done. */
	finalResult?: string
}

/**
 * Wrap a workflow step prompt with the standard instruction that makes
 * `attempt_completion` the reliable per-step boundary.
 */
export function frameWorkflowStepPrompt(prompt: string): string {
	return `${prompt}\n\n(This is one step of a larger workflow. When you have completed THIS step, call attempt_completion with a concise result for this step only — do not assume the overall task is finished.)`
}

export class WorkflowSession {
	private constructor(
		private engine: WorkflowEngine,
		private state: WorkflowState,
		readonly workflowId: string,
		private readonly deps: WorkflowSessionDeps,
	) {}

	/**
	 * The current engine state (for visualization / inspection). Read-only
	 * access so the webview can render node statuses without breaking
	 * encapsulation — callers must not mutate the returned value.
	 */
	get currentState(): WorkflowState {
		return this.state
	}

	/** Begin a fresh workflow run; returns the session and the first turn. */
	static async start(
		workflowId: string,
		inputs: Record<string, unknown>,
		deps: WorkflowSessionDeps,
	): Promise<{ session: WorkflowSession; turn: WorkflowTurn }> {
		const engine = await deps.createEngine(workflowId)
		const step = await engine.start(inputs)
		const session = new WorkflowSession(engine, step.state, workflowId, deps)
		return { session, turn: await session.consume(step) }
	}

	/** Rebuild a session from persisted state (resume after reopen). */
	static async resume(workflowId: string, state: WorkflowState, deps: WorkflowSessionDeps): Promise<WorkflowSession> {
		const engine = await deps.createEngine(workflowId)
		return new WorkflowSession(engine, state, workflowId, deps)
	}

	/** Advance the workflow with the previous step's output (e.g. the attempt_completion result). */
	async advance(lastOutput: string): Promise<WorkflowTurn> {
		const step = await this.engine.advance(this.state, lastOutput)
		return this.consume(step)
	}

	/** Apply a step: persist state, and translate it into a WorkflowTurn. */
	private async consume(step: WorkflowStep): Promise<WorkflowTurn> {
		this.state = step.state
		await this.deps.persist(this.workflowId, this.state)

		if (step.done) {
			return { done: true, finalResult: step.finalResult }
		}
		if (step.action) {
			// Phase 2: surface a delegate so the host can spawn a sub-expert.
			if (step.action.type === "delegate") {
				return { delegate: { expert: step.action.expert, goal: step.action.goal }, done: false }
			}
			// Phase 3: surface a tool/skill hard action so the host can execute it
			// mechanically (no LLM turn) and feed the result back via advance().
			if (step.action.type === "tool") {
				return {
					action: { type: "tool", name: step.action.name, params: step.action.params },
					done: false,
				}
			}
			return {
				action: { type: "skill", name: step.action.name, args: step.action.args },
				done: false,
			}
		}
		if (step.nextPrompt === undefined) {
			throw new Error("Workflow step is not done but has no nextPrompt")
		}
		return { prompt: step.nextPrompt, done: false }
	}
}
