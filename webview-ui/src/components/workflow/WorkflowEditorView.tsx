/**
 * WorkflowEditorView — a full-screen workflow editor tab (like Settings/History
 * views). Loads the workflow graph on mount, renders WorkflowView in edit mode,
 * and provides a back button to return to chat.
 *
 * This replaces the Popover-based editor for a larger, more usable editing
 * surface.
 */

import React from "react"
import type { WorkflowVizGraph } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { WorkflowView } from "./WorkflowView"

export interface WorkflowEditorViewProps {
	/** The workflow id to edit. */
	workflowId: string
	/** Called when the user clicks "back to chat". */
	onDone: () => void
}

export const WorkflowEditorView: React.FC<WorkflowEditorViewProps> = ({ workflowId, onDone }) => {
	const [graph, setGraph] = React.useState<WorkflowVizGraph | null>(null)
	const [error, setError] = React.useState<string | null>(null)

	// Load the workflow graph on mount
	React.useEffect(() => {
		setGraph(null)
		setError(null)
		vscode.postMessage({ type: "requestWorkflowGraph", workflowId })

		const handler = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "workflowGraph" && message.workflowId === workflowId && message.graph) {
				setGraph(message.graph as unknown as WorkflowVizGraph)
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [workflowId])

	// Listen for save success/errors
	React.useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "workflowSaved" && message.workflowId === workflowId) {
				// Reload the graph after save
				vscode.postMessage({ type: "requestWorkflowGraph", workflowId })
			}
			if (message.type === "workflowSaveError") {
				setError(message.error ?? "Save failed")
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [workflowId])

	return (
		<div className="h-full w-full overflow-hidden">
			{error && (
				<div className="flex flex-col items-center justify-center gap-3 h-full">
					<div className="text-sm text-red-400">{error}</div>
					<button
						className="text-[11px] px-3 py-1 rounded bg-vscode-button-background text-vscode-button-foreground hover:bg-vscode-button-hoverBackground"
						onClick={onDone}>
						Close
					</button>
				</div>
			)}
			{!error && !graph && (
				<div className="flex items-center justify-center h-full text-xs text-vscode-descriptionForeground">
					Loading workflow &quot;{workflowId}&quot;...
				</div>
			)}
			{!error && graph && (
				<WorkflowView
					workflowViz={{
						workflowId,
						graph,
						state: { results: {}, currentNodeId: null, done: false },
					}}
					editMode
				/>
			)}
		</div>
	)
}
