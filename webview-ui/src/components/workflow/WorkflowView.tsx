/**
 * WorkflowView — the main workflow visualization component (React Flow).
 *
 * Two modes:
 *  - **View** (read-only): when a workflow is executing. Shows node statuses,
 *    animated edges, click to inspect (read-only properties).
 *  - **Edit**: when the user opens the editor. Nodes are draggable,
 *    connectable; click a node to edit its config in the NodeConfigPanel;
 *    "Save" writes the dual-file format via postMessage to the backend.
 */

import React from "react"
import {
	ReactFlow,
	Background,
	Controls,
	MiniMap,
	BackgroundVariant,
	MarkerType,
	addEdge,
	type Node,
	type Edge,
	type NodeTypes,
	type Connection,
	type OnNodesChange,
	type OnEdgesChange,
	type OnConnect,
	applyNodeChanges,
	applyEdgeChanges,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import type { WorkflowVizPayload, WorkflowVizNode, WorkflowNodeStatus } from "@roo-code/types"
import { WorkflowNodeView, type WorkflowNodeData } from "./WorkflowNodeView"
import { NodeConfigPanel } from "./NodeConfigPanel"
import { NODE_TYPE_COLORS, STATUS_COLORS, NODE_TYPE_LABELS, NODE_TYPE_ICONS } from "./constants"
import { vscode } from "@/utils/vscode"

export interface WorkflowViewProps {
	workflowViz: WorkflowVizPayload
	editMode?: boolean
}

const STATUS_LEGEND: { status: WorkflowNodeStatus; label: string }[] = [
	{ status: "success", label: "Completed" },
	{ status: "current", label: "Running" },
	{ status: "error", label: "Failed" },
	{ status: "skipped", label: "Skipped" },
	{ status: "pending", label: "Pending" },
]

const nodeTypes: NodeTypes = { workflowNode: WorkflowNodeView }
const NODE_TYPE_OPTIONS = ["llm", "condition", "tool", "skill", "expert", "parallel"]

export const WorkflowView: React.FC<WorkflowViewProps> = ({ workflowViz, editMode = false }) => {
	const { graph, state } = workflowViz
	const [editNodes, setEditNodes] = React.useState<Node<WorkflowNodeData>[]>([])
	const [editEdges, setEditEdges] = React.useState<Edge[]>([])
	const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null)
	const [graphChanged, setGraphChanged] = React.useState(false)

	React.useEffect(() => {
		if (editMode) {
			setEditNodes(
				graph.nodes.map((gNode: WorkflowVizNode) => ({
					id: gNode.id,
					type: "workflowNode",
					position: gNode.position,
					data: {
						node: gNode,
						status: "pending" as WorkflowNodeStatus,
						isCurrent: false,
						onViewDetails: () => setSelectedNodeId(gNode.id),
					} as WorkflowNodeData,
					draggable: true,
					connectable: true,
					selectable: true,
				})),
			)
			setEditEdges(
				graph.edges.map((e) => ({
					id: e.id,
					source: e.source,
					target: e.target,
					type: "smoothstep",
					label: e.data?.branch,
					markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
				})),
			)
			setGraphChanged(false)
		}
	}, [editMode, graph])

	const onNodesChange: OnNodesChange = React.useCallback((changes) => {
		setEditNodes((nds) => applyNodeChanges(changes, nds) as Node<WorkflowNodeData>[])
		setGraphChanged(true)
	}, [])

	const onEdgesChange: OnEdgesChange = React.useCallback((changes) => {
		setEditEdges((eds) => applyEdgeChanges(changes, eds))
		setGraphChanged(true)
	}, [])

	const onConnect: OnConnect = React.useCallback((connection: Connection) => {
		setEditEdges((eds) =>
			addEdge({ ...connection, type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed } }, eds),
		)
		setGraphChanged(true)
	}, [])

	const handleConfigChange = React.useCallback((nodeId: string, field: string, value: unknown) => {
		setEditNodes((nds) =>
			nds.map((n) => {
				if (n.id !== nodeId) return n
				const nodeData = n.data as WorkflowNodeData
				return {
					...n,
					data: {
						...nodeData,
						node: { ...nodeData.node, data: { ...nodeData.node.data, [field]: value } },
					},
				}
			}),
		)
		setGraphChanged(true)
	}, [])

	const handleSave = React.useCallback(() => {
		const graphData: Record<string, unknown> = {
			name: graph.name,
			description: graph.description,
			version: "1.0.0",
			nodes: editNodes.map((n) => {
				const data = n.data as WorkflowNodeData
				return { id: n.id, type: data.node.type, position: n.position, data: data.node.data }
			}),
			edges: editEdges.map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				...(e.label ? { data: { branch: e.label } } : {}),
			})),
		}
		vscode.postMessage({ type: "saveWorkflow", workflowId: workflowViz.workflowId, graph: graphData })
		setGraphChanged(false)
	}, [editNodes, editEdges, graph, workflowViz.workflowId])

	const handleAddNode = React.useCallback((type: string) => {
		const id = `${type}-${Date.now().toString(36)}`
		setEditNodes((nds) => [
			...nds,
			{
				id,
				type: "workflowNode",
				position: { x: Math.random() * 300 + 100, y: Math.random() * 200 + 100 },
				data: {
					node: {
						id,
						type: type as WorkflowVizNode["type"],
						position: { x: 0, y: 0 },
						data: { exec: type === "llm" ? "soft" : "hard" },
					},
					status: "pending" as WorkflowNodeStatus,
					isCurrent: false,
					onViewDetails: () => setSelectedNodeId(id),
				} as WorkflowNodeData,
				draggable: true,
				connectable: true,
				selectable: true,
			},
		])
		setGraphChanged(true)
	}, [])

	const viewNodes: Node<WorkflowNodeData>[] = React.useMemo(() => {
		if (editMode) return editNodes
		return graph.nodes.map((gNode: WorkflowVizNode) => {
			const result = state.results[gNode.id]
			const isCurrent = state.currentNodeId === gNode.id && !state.done
			const status: WorkflowNodeStatus = isCurrent ? "current" : (result?.status ?? "pending")
			return {
				id: gNode.id,
				type: "workflowNode",
				position: gNode.position,
				data: {
					node: gNode,
					status,
					result,
					isCurrent,
					onViewDetails: () => setSelectedNodeId(gNode.id),
				} as WorkflowNodeData,
				draggable: false,
				connectable: false,
				selectable: true,
			}
		})
	}, [editMode, editNodes, graph, state])

	const viewEdges: Edge[] = React.useMemo(() => {
		if (editMode) return editEdges
		return graph.edges.map((gEdge) => {
			const srcResult = state.results[gEdge.source]
			const tgtResult = state.results[gEdge.target]
			const isOnActive =
				srcResult?.status === "success" &&
				(tgtResult?.status === "success" || state.currentNodeId === gEdge.target)
			return {
				id: gEdge.id,
				source: gEdge.source,
				target: gEdge.target,
				type: "smoothstep",
				animated: isOnActive,
				label: gEdge.data?.branch,
				labelStyle: { fontSize: 9, fill: "var(--vscode-descriptionForeground)" },
				markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
				style: {
					stroke: isOnActive ? STATUS_COLORS.current : "var(--vscode-descriptionForeground, #888)",
					strokeWidth: isOnActive ? 2 : 1,
					opacity: isOnActive ? 1 : 0.5,
				},
			}
		})
	}, [editMode, editEdges, graph, state])

	const selectedEditNode = React.useMemo(() => {
		if (!selectedNodeId || !editMode) return null
		const n = editNodes.find((nd) => nd.id === selectedNodeId)
		return n ? (n.data as WorkflowNodeData).node : null
	}, [selectedNodeId, editNodes, editMode])

	const selectedViewNode = React.useMemo(() => {
		if (!selectedNodeId || editMode) return null
		const gNode = graph.nodes.find((n) => n.id === selectedNodeId)
		return gNode ? { node: gNode, result: state.results[selectedNodeId] } : null
	}, [selectedNodeId, graph, state, editMode])

	return (
		<div className="flex flex-col h-full w-full bg-vscode-editor-background">
			<div className="flex items-center justify-between px-3 py-2 border-b border-vscode-panel-border shrink-0 z-10">
				<div className="flex items-center gap-2">
					<span className="text-sm font-semibold text-vscode-foreground">{graph.name}</span>
					{editMode && (
						<span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
							Edit Mode
						</span>
					)}
					{!editMode && state.done && (
						<span className="text-[10px] px-1.5 py-0.5 rounded bg-vscode-badge-background text-vscode-badge-foreground">
							Done
						</span>
					)}
					{!editMode && state.currentNodeId && !state.done && (
						<span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
							Running: {state.currentNodeId}
						</span>
					)}
					{editMode && graphChanged && <span className="text-[10px] text-amber-400">● Unsaved</span>}
				</div>
				<div className="flex items-center gap-2">
					{editMode && (
						<>
							<select
								className="text-[10px] px-1.5 py-0.5 rounded bg-vscode-input-background text-vscode-inputForeground border border-vscode-input-border"
								onChange={(e) => {
									if (e.target.value) handleAddNode(e.target.value)
									e.target.value = ""
								}}
								defaultValue="">
								<option value="" disabled>
									+ Add Node
								</option>
								{NODE_TYPE_OPTIONS.map((t) => (
									<option key={t} value={t}>
										{NODE_TYPE_ICONS[t]} {NODE_TYPE_LABELS[t]}
									</option>
								))}
							</select>
							<button
								className="text-[10px] px-2 py-0.5 rounded bg-vscode-button-background text-vscode-button-foreground hover:bg-vscode-button-hoverBackground disabled:opacity-50"
								onClick={handleSave}
								disabled={!graphChanged}>
								Save
							</button>
						</>
					)}
					{selectedNodeId && (
						<button
							className="text-[10px] text-vscode-descriptionForeground hover:text-vscode-foreground"
							onClick={() => setSelectedNodeId(null)}>
							Close ✕
						</button>
					)}
				</div>
			</div>

			<div className="flex-1 flex overflow-hidden">
				<div className="flex-1 relative">
					<ReactFlow
						nodes={viewNodes}
						edges={viewEdges}
						nodeTypes={nodeTypes}
						fitView
						fitViewOptions={{ padding: 0.2 }}
						nodesDraggable={editMode}
						nodesConnectable={editMode}
						edgesReconnectable={editMode}
						onNodesChange={editMode ? onNodesChange : undefined}
						onEdgesChange={editMode ? onEdgesChange : undefined}
						onConnect={editMode ? onConnect : undefined}
						onNodeClick={(_, node) => setSelectedNodeId(node.id)}
						proOptions={{ hideAttribution: true }}
						className="bg-vscode-editor-background">
						<Background variant={BackgroundVariant.Dots} gap={16} size={1} className="!opacity-20" />
						<Controls showInteractive={false} className="!bg-vscode-editor-background" />
						<MiniMap
							className="!bg-vscode-editor-background"
							nodeColor={(n) => {
								const d = n.data as unknown as WorkflowNodeData
								return STATUS_COLORS[d?.status ?? "pending"] ?? STATUS_COLORS.pending
							}}
							maskColor="rgba(0,0,0,0.5)"
						/>
					</ReactFlow>
				</div>

				{editMode && (
					<NodeConfigPanel
						node={selectedEditNode}
						onChange={handleConfigChange}
						onSave={handleSave}
						onClose={() => setSelectedNodeId(null)}
					/>
				)}

				{!editMode && selectedViewNode && (
					<div className="w-64 border-l border-vscode-panel-border p-3 overflow-y-auto shrink-0 bg-vscode-editor-background">
						<h3 className="text-xs font-semibold text-vscode-foreground mb-2">Node Properties</h3>
						<div className="space-y-2 text-[11px]">
							<div>
								<span className="text-vscode-descriptionForeground">ID: </span>
								<span className="text-vscode-foreground">{selectedViewNode.node.id}</span>
							</div>
							<div>
								<span className="text-vscode-descriptionForeground">Type: </span>
								<span className="text-vscode-foreground">
									{NODE_TYPE_ICONS[selectedViewNode.node.type]}{" "}
									{NODE_TYPE_LABELS[selectedViewNode.node.type] ?? selectedViewNode.node.type}
								</span>
							</div>
							{Object.entries(selectedViewNode.node.data)
								.slice(0, 6)
								.map(([key, value]) => (
									<div key={key} className="break-all">
										<span className="text-vscode-descriptionForeground">{key}: </span>
										<span className="text-vscode-foreground">
											{typeof value === "string"
												? value.length > 80
													? value.slice(0, 80) + "…"
													: value
												: typeof value === "object"
													? JSON.stringify(value).slice(0, 80) +
														(JSON.stringify(value).length > 80 ? "…" : "")
													: String(value)}
										</span>
									</div>
								))}
							{selectedViewNode.result && (
								<div className="pt-2 border-t border-vscode-panel-border">
									<span className="text-vscode-descriptionForeground">Status: </span>
									<span
										className="font-semibold"
										style={{ color: STATUS_COLORS[selectedViewNode.result.status] }}>
										{selectedViewNode.result.status}
									</span>
								</div>
							)}
							{selectedViewNode.result?.outputPreview && (
								<div>
									<span className="text-vscode-descriptionForeground">Output:</span>
									<pre className="mt-1 p-1.5 rounded bg-vscode-textBlockQuote-background text-vscode-foreground text-[10px] whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
										{selectedViewNode.result.outputPreview}
									</pre>
								</div>
							)}
							{selectedViewNode.result?.error && (
								<div>
									<span className="text-red-400">Error:</span>
									<pre className="mt-1 p-1.5 rounded bg-red-500/10 text-red-400 text-[10px] whitespace-pre-wrap break-all">
										{selectedViewNode.result.error}
									</pre>
								</div>
							)}
						</div>
					</div>
				)}
			</div>

			{!editMode && (
				<div className="flex flex-wrap items-center gap-3 px-3 py-2 border-t border-vscode-panel-border shrink-0 text-[10px]">
					<div className="flex items-center gap-2">
						<span className="text-vscode-descriptionForeground">Types:</span>
						{Object.entries(NODE_TYPE_LABELS).map(([type, label]) => (
							<span key={type} className="flex items-center gap-1">
								<span
									className="inline-block w-2 h-2 rounded-sm"
									style={{ backgroundColor: NODE_TYPE_COLORS[type] }}
								/>
								<span className="text-vscode-foreground">
									{NODE_TYPE_ICONS[type]} {label}
								</span>
							</span>
						))}
					</div>
					<div className="flex items-center gap-2">
						<span className="text-vscode-descriptionForeground">Status:</span>
						{STATUS_LEGEND.map(({ status, label }) => (
							<span key={status} className="flex items-center gap-1">
								<span
									className="inline-block w-2 h-2 rounded-full border"
									style={{
										borderColor: STATUS_COLORS[status],
										backgroundColor: status === "pending" ? "transparent" : STATUS_COLORS[status],
									}}
								/>
								<span className="text-vscode-foreground">{label}</span>
							</span>
						))}
					</div>
				</div>
			)}
		</div>
	)
}
