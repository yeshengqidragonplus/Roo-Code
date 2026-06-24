import { z } from "zod"

import { modeConfigSchema } from "./mode.js"

/**
 * Expert system types.
 *
 * An "Expert" is the unit that executes a long-horizon task. It is modeled as
 * an enhanced custom mode (reusing `.roomodes`), so existing mode machinery
 * (role/tool-group filtering, system-prompt construction) consumes it
 * unchanged. The only difference between the two expert kinds is configuration:
 *
 * - `autonomous` (type B): the Task loop runs free; the LLM decides each step.
 * - `workflow`   (type A): a host loop calls a bound workflow's `start/advance`
 *   each turn to obtain the next instruction; the LLM stays the actor and the
 *   workflow only constrains direction. See docs/expert-system-design.md §3.
 */

/** Execution form of an expert. */
export const expertKindSchema = z.enum(["autonomous", "workflow"])

export type ExpertKind = z.infer<typeof expertKindSchema>

/**
 * Reference to a workflow (type-A experts only). The workflow graph itself is
 * registered as a skill under `.roo/skills`; the expert stores only the
 * reference, never the graph, keeping it decoupled from the graph format.
 */
export const workflowBindingSchema = z.object({
	/** Name of the workflow skill registered under `.roo/skills`. */
	workflowSkillName: z.string().min(1),
	/** Default start inputs passed to `workflow.start()`. */
	inputs: z.record(z.unknown()).optional(),
})

export type WorkflowBinding = z.infer<typeof workflowBindingSchema>

/**
 * Sub-expert delegation policy. Delegation reuses the existing `new_task` /
 * `delegateParentAndOpenChild` machinery (serial; parent is disposed to disk
 * while the child runs, then reopened with the child's summary). See §3.2.
 */
export const delegationPolicySchema = z.object({
	/** Whether this expert may delegate sub-experts at all. */
	canDelegate: z.boolean().default(true),
	/** Allowed sub-expert slugs; empty/undefined means unrestricted. */
	allowedExperts: z.array(z.string()).optional(),
	/**
	 * Concurrency mode. Phase 1 supports `serial` only; `parallel` is reserved
	 * and requires rearchitecting the single-active-task model.
	 */
	concurrency: z.enum(["serial"]).default("serial"),
	/** Max delegation recursion depth (guards runaway sub-expert chains). */
	maxDepth: z.number().int().positive().default(3),
	/**
	 * How sub-expert results return to the parent. Locked to `summary` to
	 * prevent parent context blow-up (only the completion summary crosses back).
	 */
	reportMode: z.enum(["summary"]).default("summary"),
})

export type DelegationPolicy = z.infer<typeof delegationPolicySchema>

/**
 * Expert configuration = an enhanced ModeConfig.
 *
 * A plain custom mode with none of the extra fields validates as an
 * `autonomous` expert with default delegation, so existing `.roomodes` entries
 * keep working with zero migration.
 */
export const expertConfigSchema = modeConfigSchema
	.extend({
		kind: expertKindSchema.default("autonomous"),
		/** Required when `kind === "workflow"`. */
		workflow: workflowBindingSchema.optional(),
		delegation: delegationPolicySchema.default({}),
		/**
		 * Soft guidance for type-B experts on when the task is considered done.
		 * Kept separate from `customInstructions` to allow future programmatic
		 * completion checks.
		 */
		terminationHint: z.string().optional(),
	})
	.refine((d) => d.kind !== "workflow" || !!d.workflow, {
		message: "A workflow-kind expert must declare a `workflow` binding",
		path: ["workflow"],
	})

export type ExpertConfig = z.infer<typeof expertConfigSchema>
