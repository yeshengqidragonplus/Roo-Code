import { z } from "zod"

import type { ModeConfig } from "./mode.js"

/**
 * Expert system types.
 *
 * An "Expert" is the unit that executes a long-horizon task. It is modeled as
 * an enhanced custom mode (reusing `.roomodes`): the expert fields below are
 * mixed into `modeConfigSchema` (see mode.ts) as optional fields, so existing
 * mode machinery (role/tool-group filtering, system-prompt construction, the
 * `.roomodes` loader) carries them through unchanged and a plain mode entry
 * validates as a default `autonomous` expert with zero migration.
 *
 * The only difference between the two expert kinds is configuration:
 * - `autonomous` (type B): the Task loop runs free; the LLM decides each step.
 * - `workflow`   (type A): a host loop calls a bound workflow's `start/advance`
 *   each turn to obtain the next instruction; the LLM stays the actor and the
 *   workflow only constrains direction. See docs/expert-system-design.md §3.
 *
 * NOTE: this module must not import `modeConfigSchema` at runtime (mode.ts
 * imports these schemas, so a value import would be circular). The `ModeConfig`
 * import above is type-only and erased at compile time.
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
 * The expert-specific fields mixed into `modeConfigSchema`. All optional so a
 * plain mode entry remains valid. mode.ts spreads this into its object schema.
 */
export const expertModeFields = {
	kind: expertKindSchema.optional(),
	/** Required (validated separately) when `kind === "workflow"`. */
	workflow: workflowBindingSchema.optional(),
	delegation: delegationPolicySchema.optional(),
	/**
	 * Soft guidance for type-B experts on when the task is considered done.
	 * Kept separate from `customInstructions` to allow future programmatic
	 * completion checks.
	 */
	terminationHint: z.string().optional(),
} as const

/**
 * A mode config viewed as an expert. Since the expert fields live on
 * `ModeConfig`, this is just `ModeConfig`; the alias documents intent at call
 * sites that treat a mode as an expert.
 */
export type ExpertConfig = ModeConfig

/** True when this expert is workflow-driven (type A) rather than autonomous. */
export function isWorkflowExpert(expert: ExpertConfig): boolean {
	return expert.kind === "workflow"
}

/**
 * Validates the cross-field invariant that a workflow-kind expert declares a
 * workflow binding. The base mode schema is intentionally lenient (both fields
 * optional) so non-expert modes parse freely; callers that treat a mode as an
 * expert use this to enforce the rule.
 */
export function validateExpertConfig(expert: ExpertConfig): { ok: true } | { ok: false; error: string } {
	if (expert.kind === "workflow" && !expert.workflow) {
		return { ok: false, error: `Expert "${expert.slug}" is workflow-kind but declares no \`workflow\` binding` }
	}
	return { ok: true }
}
