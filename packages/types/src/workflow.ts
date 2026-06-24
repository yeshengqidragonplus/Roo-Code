import { z } from "zod"

/**
 * Workflow engine contract (cross-repo).
 *
 * The workflow engine + visual editor live in a separate repo. QCode only
 * depends on this contract: a workflow is a stateful state machine the host
 * calls once before each turn. The engine never executes QCode tools itself —
 * it returns either a `nextPrompt` (soft: let the LLM act) or an `action`
 * (hard: the host executes directly, no LLM turn). See
 * docs/workflow-engine-handoff.md §4.2 and docs/expert-system-design.md §3.1.
 */

/**
 * A hard, structured directive the host executes directly (no LLM turn).
 * - delegate: spawn a sub-expert and wait for its summary
 * - tool:     mechanically invoke a QCode tool
 * - skill:    mechanically run a skill
 */
export const workflowActionSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("delegate"),
		expert: z.string().min(1),
		goal: z.string().min(1),
	}),
	z.object({
		type: z.literal("tool"),
		name: z.string().min(1),
		params: z.record(z.unknown()).optional(),
	}),
	z.object({
		type: z.literal("skill"),
		name: z.string().min(1),
		args: z.record(z.unknown()).optional(),
	}),
])

export type WorkflowAction = z.infer<typeof workflowActionSchema>

/**
 * Opaque, engine-owned state. The host treats it as a JSON blob: it persists it
 * with the task and hands it back to `advance()`, never interpreting its shape.
 * Must be serializable and resumable from any persisted value (no implicit
 * in-memory dependency), so a delegate-driven dispose→reopen can continue.
 */
export type WorkflowState = unknown

/**
 * The result of `start()` / `advance()`. Exactly one of `nextPrompt` / `action`
 * is set unless `done` is true (then `finalResult` carries the outcome).
 */
export const workflowStepSchema = z.object({
	/** Updated engine state to persist and feed back into the next `advance`. */
	state: z.unknown(),
	/** Soft: instruction text for the LLM (runs one LLM turn). */
	nextPrompt: z.string().optional(),
	/** Hard: directive the host executes directly (no LLM turn). */
	action: workflowActionSchema.optional(),
	/** Whether the workflow has finished. */
	done: z.boolean(),
	/** Final outcome summary; set when `done` is true. */
	finalResult: z.string().optional(),
})

export type WorkflowStep = z.infer<typeof workflowStepSchema>

/**
 * The interface a workflow engine implementation must satisfy. Both methods may
 * be sync or async. `start` begins a run from inputs; `advance` advances the
 * state machine given the previous turn's output (LLM final text, or the result
 * of a hard action).
 */
export interface WorkflowEngine {
	start(inputs?: Record<string, unknown>): Promise<WorkflowStep> | WorkflowStep
	advance(state: WorkflowState, lastOutput: string): Promise<WorkflowStep> | WorkflowStep
}
