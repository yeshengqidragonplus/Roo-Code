import type { Node, Edge } from "@xyflow/react"
import type { WorkflowNodeData } from "./WorkflowNodeView"

/**
 * Rebuild the engine-format graph JSON from the editor's React Flow state.
 *
 * The original loaded graph is spread first so top-level fields the editor
 * does not model (`inputs`, `version`, future engine fields) survive a save
 * round-trip verbatim; only `nodes` and `edges` are replaced with the edited
 * state.
 */
export function buildSaveGraph(
	original: Record<string, unknown>,
	nodes: Node<WorkflowNodeData>[],
	edges: Edge[],
): Record<string, unknown> {
	return {
		...original,
		nodes: nodes.map((n) => {
			const data = n.data as WorkflowNodeData
			return { id: n.id, type: data.node.type, position: n.position, data: data.node.data }
		}),
		edges: edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			...(e.label ? { data: { branch: e.label } } : {}),
		})),
	}
}
