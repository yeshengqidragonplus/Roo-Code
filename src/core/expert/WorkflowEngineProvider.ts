import type { WorkflowEngine, WorkflowStep } from "@roo-code/types"

/**
 * Runtime boundary between QCode and the workflow engine (AIWorkflow).
 *
 * QCode does NOT compile or import the engine source — it loads a built engine
 * artifact at runtime and talks to it only through the frozen contract
 * (@roo-code/types/workflow.ts). This keeps the two projects decoupled so they
 * can evolve at different paces; as long as the contract holds, either side may
 * change freely. The transport (in-process dynamic import here; a subprocess
 * CLI is an alternative provider) is hidden behind this abstraction, so the
 * WorkflowExpertRunner never depends on how the engine is obtained.
 *
 * See docs/workflow-engine-handoff.md.
 */

/** Builds a contract-shaped WorkflowEngine for a given parsed workflow graph. */
export type WorkflowEngineProvider = (workflow: unknown) => Promise<WorkflowEngine>

/**
 * The minimal shape we expect from the loaded engine module. We deliberately
 * type this loosely (`unknown`-ish) because the engine's own types are not
 * imported into QCode — only the structural contract matters.
 */
interface RawEngineStep {
	state: unknown
	nextPrompt?: string
	action?: WorkflowStep["action"]
	done: boolean
	finalResult?: unknown
}

interface RawEngine {
	start(inputs: Record<string, unknown>): RawEngineStep | Promise<RawEngineStep>
	advance(state: unknown, lastOutput: unknown): RawEngineStep | Promise<RawEngineStep>
}

type RawCreateEngine = (workflow: unknown) => RawEngine

/** Coerce the engine's `unknown` finalResult into the contract's string?. */
function normalizeFinalResult(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined
	}
	return typeof value === "string" ? value : JSON.stringify(value)
}

function normalizeStep(raw: RawEngineStep): WorkflowStep {
	return {
		state: raw.state,
		nextPrompt: raw.nextPrompt,
		action: raw.action,
		done: raw.done,
		finalResult: normalizeFinalResult(raw.finalResult),
	}
}

/**
 * Adapt a raw engine (e.g. AIWorkflow's `createEngine(workflow)` result) to the
 * QCode contract: tolerate sync-or-async methods and normalize the step shape.
 * Exported for direct unit testing and for use by alternative providers.
 */
export function adaptEngine(raw: RawEngine): WorkflowEngine {
	return {
		start: async (inputs) => normalizeStep(await raw.start(inputs ?? {})),
		advance: async (state, lastOutput) => normalizeStep(await raw.advance(state, lastOutput)),
	}
}

/** Locate the `createEngine` factory on a dynamically-imported engine module. */
function resolveCreateEngine(mod: unknown): RawCreateEngine {
	const candidate =
		(mod as { createEngine?: unknown })?.createEngine ??
		(mod as { default?: { createEngine?: unknown } })?.default?.createEngine

	if (typeof candidate !== "function") {
		throw new Error("Workflow engine module does not export a `createEngine(workflow)` function")
	}
	return candidate as RawCreateEngine
}

/**
 * Build a provider that loads the engine at runtime by dynamically importing a
 * built artifact at `modulePath` (a QCode setting). The engine is never
 * compiled by QCode. `importer` is injectable for testing.
 */
export function createDynamicImportProvider(
	modulePath: string,
	importer: (path: string) => Promise<unknown> = (path) => import(path),
): WorkflowEngineProvider {
	return async (workflow: unknown) => {
		const mod = await importer(modulePath)
		const createEngine = resolveCreateEngine(mod)
		return adaptEngine(createEngine(workflow))
	}
}
