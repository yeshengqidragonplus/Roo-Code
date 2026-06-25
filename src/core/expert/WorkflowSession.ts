import type { WorkflowEngine, WorkflowState, WorkflowStep } from "@roo-code/types"

/**
 * Host-side workflow session for a type-A (workflow) expert — Phase 1: soft-only.
 *
 * The expert (Task loop) is the master; this session is consulted to obtain the
 * next step's prompt. A model `attempt_completion` marks a STEP (workflow node)
 * boundary: its result is fed to `advance()`, the workflow moves to the next
 * node, and the expert continues toward the larger goal. The whole task is
 * truly done only when `advance()`/`start()` reports `done` (the workflow
 * terminal). See docs/expert-system-design.md §7.
 *
 * Phase 1 supports soft steps only (`nextPrompt`). A hard `action`
 * (delegate/tool/skill) surfaces as a clear error until Phase 2/3 wire them in.
 */

/** Dependencies injected so the orchestration is testable in isolation. */
export interface WorkflowSessionDeps {
	/** Load + parse the workflow graph by id and build a contract WorkflowEngine. */
	createEngine: (workflowId: string) => Promise<WorkflowEngine>
	/** Persist the engine state for this session (per conversation). */
	persist: (workflowId: string, state: WorkflowState) => Promise<void>
}

/** The outcome of a session step the Task loop acts on. */
export interface WorkflowTurn {
	/** Prompt to inject for the next LLM step (undefined when done). */
	prompt?: string
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

	/** Apply a step: persist state, and translate it into a WorkflowTurn (soft-only). */
	private async consume(step: WorkflowStep): Promise<WorkflowTurn> {
		this.state = step.state
		await this.deps.persist(this.workflowId, this.state)

		if (step.done) {
			return { done: true, finalResult: step.finalResult }
		}
		if (step.action) {
			throw new Error(
				`Workflow hard actions (${step.action.type}) are not supported yet — Phase 1 is soft-only. ` +
					`Use only soft (LLM) steps for now.`,
			)
		}
		if (step.nextPrompt === undefined) {
			throw new Error("Workflow step is not done but has no nextPrompt")
		}
		return { prompt: step.nextPrompt, done: false }
	}
}
