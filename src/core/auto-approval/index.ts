import {
	type ClineAsk,
	type ClineSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	isNonBlockingAsk,
} from "@roo-code/types"

import { ClineAskResponse } from "../../shared/WebviewMessage"

import { isWriteToolAction, isReadOnlyToolAction } from "./tools"
import { isMcpToolAlwaysAllowed } from "./mcp"
import { getCommandDecision } from "./commands"

// We have auto-approval actions for different categories.
export type AutoApprovalState =
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowMcp"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "alwaysAllowFollowupQuestions"

// Some of these actions have additional settings associated with them.
export type AutoApprovalStateOptions =
	| "autoApprovalEnabled"
	| "autoApprovalMode" // Session-level posture: "manual" (default) | "sandbox".
	| "alwaysAllowReadOnlyOutsideWorkspace" // For `alwaysAllowReadOnly`.
	| "alwaysAllowWriteOutsideWorkspace" // For `alwaysAllowWrite`.
	| "alwaysAllowWriteProtected"
	| "followupAutoApproveTimeoutMs" // For `alwaysAllowFollowupQuestions`.
	| "mcpServers" // For `alwaysAllowMcp`.
	| "allowedCommands" // For `alwaysAllowExecute`.
	| "deniedCommands"

export type CheckAutoApprovalResult =
	| { decision: "approve" }
	| { decision: "deny" }
	| { decision: "ask" }
	| {
			decision: "timeout"
			timeout: number
			fn: () => { askResponse: ClineAskResponse; text?: string; images?: string[] }
	  }

export async function checkAutoApproval({
	state,
	ask,
	text,
	isProtected,
	workgroupCommandTrusted,
}: {
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	ask: ClineAsk
	text?: string
	isProtected?: boolean
	/** Defined only for workgroup command approvals; legacy Modes never set it. */
	workgroupCommandTrusted?: boolean
}): Promise<CheckAutoApprovalResult> {
	if (isNonBlockingAsk(ask)) {
		return { decision: "approve" }
	}

	// A workgroup deliberately has a separate command trust model. Do this before
	// sandbox/legacy settings so a global prefix allow-list cannot bypass its exact
	// SHA-256 project whitelist.
	if (ask === "command" && workgroupCommandTrusted !== undefined) {
		return workgroupCommandTrusted ? { decision: "approve" } : { decision: "ask" }
	}

	// Session-level "sandbox autonomy" posture. This is an ADDITIVE pre-layer:
	// when the mode is anything other than "sandbox" (including undefined), we
	// fall straight through to the legacy per-category logic below, so existing
	// behavior is byte-for-byte unchanged. See docs/approval-mechanism-design.md.
	if (state?.autoApprovalMode === "sandbox") {
		return checkSandboxApproval({ state, ask, text, isProtected })
	}

	if (!state || !state.autoApprovalEnabled) {
		return { decision: "ask" }
	}

	if (ask === "followup") {
		if (state.alwaysAllowFollowupQuestions === true) {
			try {
				const suggestion = (JSON.parse(text || "{}") as FollowUpData).suggest?.[0]

				if (
					suggestion &&
					typeof state.followupAutoApproveTimeoutMs === "number" &&
					state.followupAutoApproveTimeoutMs > 0
				) {
					return {
						decision: "timeout",
						timeout: state.followupAutoApproveTimeoutMs,
						fn: () => ({ askResponse: "messageResponse", text: suggestion.answer }),
					}
				} else {
					return { decision: "ask" }
				}
			} catch (error) {
				return { decision: "ask" }
			}
		} else {
			return { decision: "ask" }
		}
	}

	if (ask === "use_mcp_server") {
		if (!text) {
			return { decision: "ask" }
		}

		try {
			const mcpServerUse = JSON.parse(text) as McpServerUse

			if (mcpServerUse.type === "use_mcp_tool") {
				return state.alwaysAllowMcp === true && isMcpToolAlwaysAllowed(mcpServerUse, state.mcpServers)
					? { decision: "approve" }
					: { decision: "ask" }
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return state.alwaysAllowMcp === true ? { decision: "approve" } : { decision: "ask" }
			}
		} catch (error) {
			return { decision: "ask" }
		}

		return { decision: "ask" }
	}

	if (ask === "command") {
		if (!text) {
			return { decision: "ask" }
		}

		if (state.alwaysAllowExecute === true) {
			const decision = getCommandDecision(text, state.allowedCommands || [], state.deniedCommands || [])

			if (decision === "auto_approve") {
				return { decision: "approve" }
			} else if (decision === "auto_deny") {
				return { decision: "deny" }
			} else {
				return { decision: "ask" }
			}
		}
	}

	if (ask === "tool") {
		let tool: ClineSayTool | undefined

		try {
			tool = JSON.parse(text || "{}")
		} catch (error) {
			console.error("Failed to parse tool:", error)
		}

		if (!tool) {
			return { decision: "ask" }
		}

		if (tool.tool === "updateTodoList") {
			return { decision: "approve" }
		}

		// The skill tool only loads pre-defined instructions from global or project skills.
		// It does not read arbitrary files - skills must be explicitly installed/defined by the user.
		// Auto-approval is intentional to provide a seamless experience when loading task instructions.
		if (tool.tool === "skill") {
			return { decision: "approve" }
		}

		if (tool?.tool === "switchMode") {
			return state.alwaysAllowModeSwitch === true ? { decision: "approve" } : { decision: "ask" }
		}

		if (["newTask", "finishTask"].includes(tool?.tool)) {
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		const isOutsideWorkspace = !!tool.isOutsideWorkspace

		if (isReadOnlyToolAction(tool)) {
			return state.alwaysAllowReadOnly === true &&
				(!isOutsideWorkspace || state.alwaysAllowReadOnlyOutsideWorkspace === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}

		if (isWriteToolAction(tool)) {
			return state.alwaysAllowWrite === true &&
				(!isOutsideWorkspace || state.alwaysAllowWriteOutsideWorkspace === true) &&
				(!isProtected || state.alwaysAllowWriteProtected === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}
	}

	return { decision: "ask" }
}

/**
 * Sandbox-autonomy decision rules (session mode "sandbox" / L1).
 *
 * The guiding principle: approval is friction only when an action is
 * irreversible or escapes the project. Inside the workspace, git checkpoints
 * are the safety net, so read/write auto-approve. Anything that leaves the
 * workspace, or a command not on the trust list, still asks. Follow-up
 * questions always wait for a human — there is no countdown in this mode.
 *
 * NOTE (deferred, see design doc): file *deletion* is not given blanket
 * auto-approval here — deletes flow through the command trust list until the
 * recycle-staging safety net lands. Irreplaceable git-ignored files
 * (keystores, .env) should be added to `.rooprotected`; `isProtected` forces
 * an ask even inside the workspace.
 */
function checkSandboxApproval({
	state,
	ask,
	text,
	isProtected,
}: {
	state: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	ask: ClineAsk
	text?: string
	isProtected?: boolean
}): CheckAutoApprovalResult {
	// Follow-up questions: a human is present in this mode — always wait, never
	// auto-select. (The legacy countdown lives only in "manual" mode.)
	if (ask === "followup") {
		return { decision: "ask" }
	}

	// Commands: trust list approves, deny list denies, anything new asks.
	// Sandbox mode is itself the enablement, so this does not require
	// `alwaysAllowExecute`.
	if (ask === "command") {
		if (!text) {
			return { decision: "ask" }
		}
		const decision = getCommandDecision(text, state.allowedCommands || [], state.deniedCommands || [])
		if (decision === "auto_approve") {
			return { decision: "approve" }
		} else if (decision === "auto_deny") {
			return { decision: "deny" }
		}
		return { decision: "ask" }
	}

	// MCP tools can reach outside the sandbox, so they still require an explicit
	// per-tool always-allow mark; otherwise ask.
	if (ask === "use_mcp_server") {
		if (!text) {
			return { decision: "ask" }
		}
		try {
			const mcpServerUse = JSON.parse(text) as McpServerUse
			if (mcpServerUse.type === "use_mcp_tool") {
				return isMcpToolAlwaysAllowed(mcpServerUse, state.mcpServers)
					? { decision: "approve" }
					: { decision: "ask" }
			}
		} catch {
			return { decision: "ask" }
		}
		return { decision: "ask" }
	}

	if (ask === "tool") {
		let tool: ClineSayTool | undefined
		try {
			tool = JSON.parse(text || "{}")
		} catch {
			return { decision: "ask" }
		}
		if (!tool) {
			return { decision: "ask" }
		}

		// Zero-cost, no-side-effect tools: always fine.
		if (tool.tool === "updateTodoList" || tool.tool === "skill") {
			return { decision: "approve" }
		}

		// Mode switches and subtasks are low-risk orchestration in sandbox mode.
		if (tool.tool === "switchMode" || ["newTask", "finishTask"].includes(tool.tool)) {
			return { decision: "approve" }
		}

		const isOutsideWorkspace = !!tool.isOutsideWorkspace

		// Reading inside the workspace is free; outside always asks.
		if (isReadOnlyToolAction(tool)) {
			return isOutsideWorkspace ? { decision: "ask" } : { decision: "approve" }
		}

		// Writing inside the workspace is git-recoverable; outside always asks,
		// and protected (red-line) files always ask.
		if (isWriteToolAction(tool)) {
			if (isOutsideWorkspace || isProtected) {
				return { decision: "ask" }
			}
			return { decision: "approve" }
		}
	}

	return { decision: "ask" }
}

export { AutoApprovalHandler } from "./AutoApprovalHandler"
