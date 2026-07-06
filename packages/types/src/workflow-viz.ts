/**
 * Workflow visualization types — a display-oriented projection of the engine's
 * internal `WorkflowState`. QCode treats the engine state as opaque for the
 * host loop, but the webview needs a typed shape to render node statuses. This
 * file defines that projection; the backend converts from the raw engine state
 * before posting to the webview (see ClineProvider.getStateToPostToWebview).
 *
 * The graph definition itself (nodes + edges) is the same JSON format the
 * AIWorkflow editor produces — nodes already carry `position: {x, y}` for
 * canvas layout.
 */

/** A single node in the workflow graph (editor format, unchanged). */
export interface WorkflowVizNode {
	id: string
	type: "llm" | "condition" | "tool" | "skill" | "expert" | "parallel"
	position: { x: number; y: number }
	data: Record<string, unknown>
}

/** An edge connecting two nodes; condition edges carry a `branch` label. */
export interface WorkflowVizEdge {
	id: string
	source: string
	target: string
	data?: { branch?: "true" | "false" }
}

/** The complete workflow graph (editor JSON, passthrough). */
export interface WorkflowVizGraph {
	name: string
	description: string
	/** Engine-format passthrough (preserved verbatim across save round-trips). */
	version?: string
	/** Workflow input declarations (engine format, passthrough). */
	inputs?: unknown[]
	nodes: WorkflowVizNode[]
	edges: WorkflowVizEdge[]
}

/** Execution status of a single node, projected from the engine's NodeResult. */
export type WorkflowNodeStatus = "success" | "error" | "skipped" | "current" | "pending"

/** A node's execution result projected for display. */
export interface WorkflowNodeResult {
	nodeId: string
	status: WorkflowNodeStatus
	/** Shortened output preview (truncated for display). */
	outputPreview?: string
	/** Error message if status is "error". */
	error?: string
}

/**
 * The runtime state of a workflow run, projected for visualization. This is a
 * *copy* of the engine state's display-relevant fields — the engine's own
 * state remains opaque to the host loop.
 */
export interface WorkflowVizState {
	/** Map of nodeId → execution result; absent nodes are "pending". */
	results: Record<string, WorkflowNodeResult>
	/** The node currently awaiting output (highlighted as "current"). */
	currentNodeId: string | null
	/** Whether the entire workflow has finished. */
	done: boolean
	/** Human-readable summary of the final result, if done. */
	finalResult?: string
}

/**
 * The full payload posted to the webview when a workflow expert is active.
 * Undefined when the current task is not a workflow-driven expert.
 */
export interface WorkflowVizPayload {
	workflowId: string
	graph: WorkflowVizGraph
	state: WorkflowVizState
}
