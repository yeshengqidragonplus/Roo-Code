/**
 * Project the engine's opaque WorkflowState into the display-oriented
 * WorkflowVizState for the webview. This is the *only* place that interprets
 * the engine state's internal shape — the host loop itself never reads these
 * fields, keeping the "opaque state" contract intact.
 *
 * The engine state (from AIWorkflow types.ts) looks like:
 *   { inputs, results: { [nodeId]: { nodeId, output, status, error? } },
 *     currentNodeId, done, finalResult? }
 *
 * We copy only the display-relevant fields and truncate outputs to short
 * previews so we don't send large blobs to the webview on every state push.
 */

import type { WorkflowVizState, WorkflowNodeResult, WorkflowNodeStatus } from "@roo-code/types"

/** Max characters of a node's output to include in the preview. */
const OUTPUT_PREVIEW_LIMIT = 200

/**
 * Project a raw engine state (typed as `unknown` per the contract) into a
 * WorkflowVizState. Returns undefined if the state is missing or malformed —
 * the caller should treat that as "no workflow active".
 */
export function projectWorkflowState(rawState: unknown): WorkflowVizState | undefined {
	if (!rawState || typeof rawState !== "object") return undefined

	const s = rawState as Record<string, unknown>
	const rawResults = s.results
	if (!rawResults || typeof rawResults !== "object") return undefined

	const currentNodeId = typeof s.currentNodeId === "string" ? s.currentNodeId : null
	const done = s.done === true

	const results: Record<string, WorkflowNodeResult> = {}
	for (const [nodeId, raw] of Object.entries(rawResults as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue
		const r = raw as Record<string, unknown>

		// Map engine status → display status (current overrides when applicable)
		const engineStatus = typeof r.status === "string" ? r.status : "success"
		const status: WorkflowNodeStatus =
			nodeId === currentNodeId && !done ? "current" : (engineStatus as WorkflowNodeStatus)

		// Build a short output preview
		let outputPreview: string | undefined
		const output = r.output
		if (output !== undefined && output !== null) {
			const str = typeof output === "string" ? output : JSON.stringify(output)
			outputPreview = str.length > OUTPUT_PREVIEW_LIMIT ? str.slice(0, OUTPUT_PREVIEW_LIMIT) + "…" : str
		}

		results[nodeId] = {
			nodeId,
			status,
			outputPreview,
			error: typeof r.error === "string" ? r.error : undefined,
		}
	}

	// finalResult may be an object (leaf outputs) or a string
	let finalResult: string | undefined
	if (done && s.finalResult !== undefined && s.finalResult !== null) {
		finalResult =
			typeof s.finalResult === "string"
				? s.finalResult
				: JSON.stringify(s.finalResult, null, 2).slice(0, OUTPUT_PREVIEW_LIMIT * 4)
	}

	return { results, currentNodeId, done, finalResult }
}
