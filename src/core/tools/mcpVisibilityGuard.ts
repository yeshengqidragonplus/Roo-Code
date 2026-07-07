import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { defaultModeSlug } from "../../shared/modes"
import { isServerVisibleToMode } from "../../services/mcp/mode-visibility"

/**
 * Checks the server's `modes` visibility whitelist against the current mode.
 * Returns true when execution may proceed. On failure it pushes a tool error
 * that points the model at new_task delegation instead of retrying.
 *
 * Invisible servers are already excluded from the tools array at injection
 * time; this guards against the model imitating tool names from conversation
 * history (defense in depth).
 */
export async function ensureServerVisibleToMode(
	task: Task,
	toolName: "use_mcp_tool" | "access_mcp_resource",
	serverName: string,
	pushToolResult: (content: string) => void,
): Promise<boolean> {
	let server
	let modeSlug: string

	try {
		const provider = task.providerRef.deref()
		const mcpHub = provider?.getMcpHub()
		server = mcpHub?.getServers().find((s) => s.name === serverName)

		if (!server) {
			// Unknown or disabled server — existence validation handles that case
			return true
		}

		const state = await provider?.getState()
		modeSlug = state?.mode ?? defaultModeSlug
	} catch (error) {
		// Same posture as validateToolExists: an error while checking must not
		// block execution — this guard is defense in depth, the primary filter
		// runs at injection time and approval still gates the actual call.
		console.error("Error checking MCP server mode visibility:", error)
		return true
	}

	if (isServerVisibleToMode(server, modeSlug)) {
		return true
	}

	task.consecutiveMistakeCount++
	task.recordToolError(toolName)
	await task.say("error", t("mcp:errors.serverNotVisibleToMode", { serverName, mode: modeSlug }))
	task.didToolFailInCurrentTurn = true
	pushToolResult(formatResponse.toolError(formatResponse.mcpServerNotVisibleToMode(serverName, modeSlug)))
	return false
}
