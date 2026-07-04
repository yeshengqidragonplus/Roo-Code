/**
 * Visual constants for the workflow graph. Shared between the node view and
 * the main WorkflowView component so colors and labels stay consistent.
 *
 * Colors use hex values (used as SVG fill/stroke by React Flow) chosen to be
 * distinguishable in both light and dark themes. Node type accent colors are
 * used for the left border strip; status colors for the node border + legend.
 */

/** Accent color per node type (left strip fill + legend dot). */
export const NODE_TYPE_COLORS: Record<string, string> = {
	llm: "#6366f1", // indigo
	condition: "#f59e0b", // amber
	tool: "#10b981", // emerald
	skill: "#06b6d4", // cyan
	expert: "#ec4899", // pink
	parallel: "#6b7280", // gray
}

/** Status border color (node border + legend dot + edge highlight). */
export const STATUS_COLORS: Record<string, string> = {
	success: "#10b981", // green
	error: "#ef4444", // red
	skipped: "#9ca3af", // gray
	current: "#3b82f6", // blue
	pending: "#4b5563", // slate (subtle)
}

/** A short icon glyph per node type (rendered in the node card + legend). */
export const NODE_TYPE_ICONS: Record<string, string> = {
	llm: "✦",
	condition: "⑂",
	tool: "🔧",
	skill: "⚡",
	expert: "👤",
	parallel: "⇄",
}

/** A human-readable label per node type (node card + legend). */
export const NODE_TYPE_LABELS: Record<string, string> = {
	llm: "LLM",
	condition: "Condition",
	tool: "Tool",
	skill: "Skill",
	expert: "Expert",
	parallel: "Parallel",
}
