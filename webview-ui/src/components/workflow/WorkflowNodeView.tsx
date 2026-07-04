/**
 * React Flow custom node for the workflow graph.
 *
 * Renders a card with:
 *  - A colored left strip indicating node type (llm/condition/tool/skill/expert)
 *  - A type icon + label
 *  - The node id / prompt preview as title
 *  - A colored border indicating execution status (success/error/skipped/current/pending)
 *  - A "view details" button that opens a properties popover
 *
 * The node is styled with Tailwind + VS Code CSS variables. Status colors
 * come from the shared constants.
 */

import React from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import type { WorkflowVizNode, WorkflowNodeStatus, WorkflowNodeResult } from "@roo-code/types"
import { NODE_TYPE_COLORS, STATUS_COLORS, NODE_TYPE_ICONS, NODE_TYPE_LABELS } from "./constants"

/** Data passed from the parent WorkflowView into each node via node.data. */
export interface WorkflowNodeData extends Record<string, unknown> {
	/** The original workflow graph node. */
	node: WorkflowVizNode
	/** Execution status (current/success/error/skipped/pending). */
	status: WorkflowNodeStatus
	/** The full result (output preview + error), if the node has run. */
	result?: WorkflowNodeResult
	/** Whether this node is currently executing (for pulse animation). */
	isCurrent: boolean
	/** Callback when the user clicks "view details". */
	onViewDetails?: (node: WorkflowVizNode, result?: WorkflowNodeResult) => void
}

/** Derive a short display name from node id or data. */
function getDisplayName(node: WorkflowVizNode): string {
	if (typeof node.data?.prompt === "string" && node.data.prompt.length > 0) {
		const firstLine = (node.data.prompt as string).split("\n")[0]
		return firstLine.length > 35 ? firstLine.slice(0, 35) + "…" : firstLine
	}
	return node.id
}

export const WorkflowNodeView: React.FC<NodeProps> = ({ data }) => {
	const { node, status, result, isCurrent, onViewDetails } = data as unknown as WorkflowNodeData
	const typeColor = NODE_TYPE_COLORS[node.type] ?? NODE_TYPE_COLORS.llm
	const borderColor = STATUS_COLORS[status] ?? STATUS_COLORS.pending
	const icon = NODE_TYPE_ICONS[node.type] ?? "•"
	const typeLabel = NODE_TYPE_LABELS[node.type] ?? node.type
	const displayName = getDisplayName(node)

	return (
		<div
			className="relative rounded-lg bg-vscode-editor-background shadow-md transition-all"
			style={{
				borderColor,
				borderWidth: status === "pending" ? 1 : 2,
				borderStyle: "solid",
				width: 180,
				overflow: "hidden",
				boxShadow: isCurrent ? `0 0 0 3px ${borderColor}40` : undefined,
			}}>
			{/* Left type-color strip */}
			<div className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: typeColor }} />

			{/* Input handle (top) */}
			<Handle
				type="target"
				position={Position.Top}
				className="!w-2 !h-1.5 !bg-vscode-descriptionForeground !border-none !opacity-60"
			/>

			{/* Node content */}
			<div className="pl-3 pr-2 py-2">
				<div className="flex items-center gap-1.5">
					<span className="text-sm" style={{ color: typeColor }}>
						{icon}
					</span>
					<span className="text-[9px] text-vscode-descriptionForeground">{typeLabel}</span>
					{status === "error" && <span className="ml-auto text-xs text-red-500">✕</span>}
					{status === "skipped" && (
						<span className="ml-auto text-xs text-vscode-descriptionForeground opacity-50">⊘</span>
					)}
				</div>
				<div className="text-[11px] font-semibold text-vscode-foreground mt-0.5 truncate" title={displayName}>
					{displayName}
				</div>
				{status === "success" && result?.outputPreview && (
					<div className="text-[8px] text-vscode-descriptionForeground mt-0.5 truncate opacity-70">
						{result.outputPreview.slice(0, 30)}
					</div>
				)}
			</div>

			{/* Action bar */}
			{(result || status === "current") && (
				<button
					className="w-full text-[9px] py-0.5 border-t border-vscode-panel-border text-vscode-descriptionForeground hover:bg-vscode-list-hoverBackground hover:text-vscode-foreground transition-colors"
					onClick={(e) => {
						e.stopPropagation()
						onViewDetails?.(node, result)
					}}>
					View details
				</button>
			)}

			{/* Output handle (bottom) */}
			<Handle
				type="source"
				position={Position.Bottom}
				className="!w-2 !h-1.5 !bg-vscode-descriptionForeground !border-none !opacity-60"
			/>
		</div>
	)
}
