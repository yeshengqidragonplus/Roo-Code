import type { ToolUsePolicy } from "@roo-code/types"

export function getSharedToolUseSection(policy: ToolUsePolicy = "on-demand"): string {
	const policyGuidance =
		policy === "evidence-required"
			? "Before reporting completion, use relevant available tools to obtain verifiable evidence whenever such evidence is needed. Do not call irrelevant tools merely to satisfy this rule."
			: "Use available tools when they materially improve accuracy, gather needed facts, make changes, or verify results. Do not call tools merely to satisfy a quota."

	return `====

TOOL USE

You have access to a set of tools that are executed upon the user's approval. Use the provider-native tool-calling mechanism. Do not include XML markup or examples. ${policyGuidance} When several independent tool calls are needed, prefer grouping the reasonably necessary calls to reduce back-and-forth.`
}
