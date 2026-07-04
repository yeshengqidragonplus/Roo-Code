/**
 * NodeConfigPanel — the right-side configuration editor for a selected workflow
 * node. Renders different form fields based on the node type:
 *
 * - llm: prompt (textarea), outputSchema (JSON editor)
 * - condition: expression (input)
 * - tool: toolName (input), params (JSON editor)
 * - skill: skillName (input), args (JSON editor)
 * - expert: subtaskPrompt (textarea), expertId/mode (input)
 *
 * Changes are applied to a local draft; the parent WorkflowView handles the
 * actual save (postMessage to backend).
 */

import React from "react"
import type { WorkflowVizNode } from "@roo-code/types"
import { NODE_TYPE_ICONS, NODE_TYPE_LABELS } from "./constants"

export interface NodeConfigPanelProps {
	/** The selected node to edit (null = panel hidden). */
	node: WorkflowVizNode | null
	/** Called when the user edits a field. */
	onChange: (nodeId: string, field: string, value: unknown) => void
	/** Called when the user clicks "Save". */
	onSave: () => void
	/** Called when the user clicks "Cancel" / closes the panel. */
	onClose: () => void
}

/** Fields that belong to each node type's content config. */
const NODE_CONFIG_FIELDS: Record<string, { key: string; label: string; type: "text" | "textarea" | "json" }[]> = {
	llm: [
		{ key: "prompt", label: "Prompt", type: "textarea" },
		{ key: "outputSchema", label: "Output Schema (JSON)", type: "json" },
	],
	condition: [{ key: "expression", label: "Expression", type: "text" }],
	tool: [
		{ key: "toolName", label: "Tool Name", type: "text" },
		{ key: "params", label: "Params (JSON)", type: "json" },
	],
	skill: [
		{ key: "skillName", label: "Skill Name", type: "text" },
		{ key: "args", label: "Args (JSON)", type: "json" },
	],
	expert: [
		{ key: "subtaskPrompt", label: "Subtask Prompt", type: "textarea" },
		{ key: "expertId", label: "Expert ID (or Mode)", type: "text" },
	],
	parallel: [],
}

function FieldEditor({
	field,
	value,
	onChange,
}: {
	field: { key: string; label: string; type: "text" | "textarea" | "json" }
	value: unknown
	onChange: (value: unknown) => void
}) {
	const [jsonError, setJsonError] = React.useState<string | null>(null)
	const strValue = React.useMemo(() => {
		if (value === undefined || value === null) return ""
		if (field.type === "json") {
			try {
				return JSON.stringify(value, null, 2)
			} catch {
				return String(value)
			}
		}
		return String(value)
	}, [value, field.type])

	const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		const raw = e.target.value
		if (field.type === "json") {
			if (raw.trim() === "") {
				setJsonError(null)
				onChange(undefined)
				return
			}
			try {
				const parsed = JSON.parse(raw)
				setJsonError(null)
				onChange(parsed)
			} catch (err) {
				setJsonError(err instanceof Error ? err.message : "Invalid JSON")
			}
		} else {
			onChange(raw)
		}
	}

	if (field.type === "textarea") {
		return (
			<div>
				<label className="text-[10px] text-vscode-descriptionForeground block mb-1">{field.label}</label>
				<textarea
					className="w-full text-[11px] p-2 rounded bg-vscode-input-background text-vscode-inputForeground border border-vscode-input-border focus:outline-none resize-y min-h-[80px]"
					value={strValue}
					onChange={handleChange}
					placeholder={`Enter ${field.label.toLowerCase()}...`}
				/>
			</div>
		)
	}

	if (field.type === "json") {
		return (
			<div>
				<label className="text-[10px] text-vscode-descriptionForeground block mb-1">{field.label}</label>
				<textarea
					className="w-full text-[10px] font-mono p-2 rounded bg-vscode-input-background text-vscode-inputForeground border border-vscode-input-border focus:outline-none resize-y min-h-[100px]"
					value={strValue}
					onChange={handleChange}
					spellCheck={false}
					placeholder="{}"
				/>
				{jsonError && <p className="text-[9px] text-red-400 mt-0.5">JSON Error: {jsonError}</p>}
			</div>
		)
	}

	// text input
	return (
		<div>
			<label className="text-[10px] text-vscode-descriptionForeground block mb-1">{field.label}</label>
			<input
				type="text"
				className="w-full text-[11px] px-2 py-1 rounded bg-vscode-input-background text-vscode-inputForeground border border-vscode-input-border focus:outline-none"
				value={strValue}
				onChange={handleChange}
				placeholder={`Enter ${field.label.toLowerCase()}...`}
			/>
		</div>
	)
}

export const NodeConfigPanel: React.FC<NodeConfigPanelProps> = ({ node, onChange, onSave, onClose }) => {
	if (!node) return null

	const fields = NODE_CONFIG_FIELDS[node.type] ?? []
	const icon = NODE_TYPE_ICONS[node.type] ?? "•"
	const typeLabel = NODE_TYPE_LABELS[node.type] ?? node.type

	return (
		<div className="w-72 border-l border-vscode-panel-border flex flex-col shrink-0 bg-vscode-editor-background">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-vscode-panel-border">
				<div className="flex items-center gap-2">
					<span className="text-sm">{icon}</span>
					<span className="text-xs font-semibold text-vscode-foreground">{typeLabel} Config</span>
				</div>
				<button
					className="text-vscode-descriptionForeground hover:text-vscode-foreground text-xs"
					onClick={onClose}>
					✕
				</button>
			</div>

			{/* Node info */}
			<div className="px-3 py-2 border-b border-vscode-panel-border">
				<div className="text-[10px] text-vscode-descriptionForeground">Node ID</div>
				<div className="text-[11px] font-mono text-vscode-foreground">{node.id}</div>
			</div>

			{/* Config fields */}
			<div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
				{fields.length === 0 ? (
					<p className="text-[10px] text-vscode-descriptionForeground italic">
						This node type ({typeLabel}) has no configurable fields.
					</p>
				) : (
					fields.map((field) => (
						<FieldEditor
							key={field.key}
							field={field}
							value={node.data[field.key]}
							onChange={(value) => onChange(node.id, field.key, value)}
						/>
					))
				)}

				{/* exec field (architecture, but editable here for convenience) */}
				<div>
					<label className="text-[10px] text-vscode-descriptionForeground block mb-1">Execution Mode</label>
					<select
						className="w-full text-[11px] px-2 py-1 rounded bg-vscode-input-background text-vscode-inputForeground border border-vscode-input-border focus:outline-none"
						value={(node.data.exec as string) ?? (node.type === "llm" ? "soft" : "hard")}
						onChange={(e) => onChange(node.id, "exec", e.target.value)}>
						<option value="soft">Soft (LLM turn)</option>
						<option value="hard">Hard (no LLM turn)</option>
					</select>
				</div>
			</div>

			{/* Footer */}
			<div className="flex gap-2 px-3 py-2 border-t border-vscode-panel-border">
				<button
					className="flex-1 text-[11px] px-2 py-1 rounded bg-vscode-button-background text-vscode-button-foreground hover:bg-vscode-button-hoverBackground transition-colors"
					onClick={onSave}>
					Save Workflow
				</button>
				<button
					className="text-[11px] px-2 py-1 rounded text-vscode-descriptionForeground hover:bg-vscode-list-hoverBackground transition-colors"
					onClick={onClose}>
					Close
				</button>
			</div>
		</div>
	)
}
