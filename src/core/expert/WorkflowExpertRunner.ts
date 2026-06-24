import type { WorkflowAction, WorkflowEngine, WorkflowState, WorkflowStep } from "@roo-code/types"

/**
 * Side effects the runner needs from the host. Injected so the control loop is
 * unit-testable in isolation and decoupled from Task.ts. The real integration
 * supplies implementations that drive a Task turn, the delegation machinery,
 * the tool/skill dispatchers, and task-scoped state persistence.
 */
export interface WorkflowExpertRunnerDeps {
	/** Run one LLM turn with `prompt` injected (system prompt unchanged); resolve with the turn's final text. */
	runLlmTurn(prompt: string): Promise<string>
	/** Execute a hard action directly (no LLM turn); resolve with a result string fed back into `advance`. */
	executeAction(action: WorkflowAction): Promise<string>
	/** Persist the engine state with the task so a dispose→reopen can resume. */
	persistState(state: WorkflowState): Promise<void>
	/** Optional observer for logging / UI, called for every step before it is acted on. */
	onStep?(step: WorkflowStep): void
}

/** Safety backstop against a malformed engine that never reports `done`. */
const MAX_STEPS = 1000

/**
 * Drives a type-A (workflow) expert: the host calls the bound workflow's
 * `start`/`advance` each turn and acts on the result — soft (`nextPrompt` → one
 * LLM turn) or hard (`action` → direct execution, no LLM turn). The LLM stays
 * the actor; the workflow only constrains direction.
 *
 * See docs/expert-system-design.md §3.1.
 */
export class WorkflowExpertRunner {
	constructor(
		private readonly engine: WorkflowEngine,
		private readonly deps: WorkflowExpertRunnerDeps,
	) {}

	/** Start a fresh run from `inputs` and drive it to completion. Returns the final result. */
	async run(inputs?: Record<string, unknown>): Promise<string> {
		const step = await this.engine.start(inputs)
		return this.loop(step)
	}

	/**
	 * Resume a run after a dispose→reopen (e.g. following a delegate action). The
	 * host loads the persisted `state` and supplies the sub-expert's summary as
	 * `lastOutput`; the loop continues from `advance(state, lastOutput)`.
	 */
	async resumeFrom(state: WorkflowState, lastOutput: string): Promise<string> {
		const step = await this.engine.advance(state, lastOutput)
		return this.loop(step)
	}

	/** The core control loop, shared by `run` and `resumeFrom`. */
	private async loop(initial: WorkflowStep): Promise<string> {
		let step = initial

		for (let i = 0; i < MAX_STEPS; i++) {
			this.deps.onStep?.(step)
			await this.deps.persistState(step.state)

			if (step.done) {
				return step.finalResult ?? ""
			}

			// Produce this turn's output: hard action (no LLM turn) or soft prompt.
			let lastOutput: string
			if (step.action) {
				lastOutput = await this.deps.executeAction(step.action)
			} else if (step.nextPrompt !== undefined) {
				lastOutput = await this.deps.runLlmTurn(step.nextPrompt)
			} else {
				throw new Error("Workflow step is not done but has neither an action nor a nextPrompt")
			}

			step = await this.engine.advance(step.state, lastOutput)
		}

		throw new Error(`Workflow exceeded ${MAX_STEPS} steps without completing`)
	}
}
