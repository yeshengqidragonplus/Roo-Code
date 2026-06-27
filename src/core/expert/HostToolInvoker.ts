/**
 * HostToolInvoker — Phase 3: mechanically execute a tool/skill at a workflow
 * hard node, WITHOUT an LLM turn. See docs/workflow-phase3-plan.md §2.
 *
 * The workflow engine returns a hard `{type:"tool", name, params}` action; the
 * host (Task loop) calls this invoker to run the named tool directly and obtain
 * its result text, which is then fed back into `workflow.advance()` as the
 * lastOutput. Because the tool is NOT model-initiated, there is no dangling
 * `tool_use` in the API conversation — the result travels an out-of-band
 * channel (the return value) and only enters the conversation later, as text,
 * when a soft LLM node references `{{node.output}}`.
 *
 * Permission model (§4.2): a workflow expert declares `toolPolicy` (allowedTools
 * / allowedCategories). This is SEPARATE from the mode's `groups` (which gate
 * model-visible tools in the system prompt) so hard tools stay model-invisible
 * and the prompt-cache prefix stays stable. Default empty = nothing allowed
 * (fail-safe). Unauthorized → reject + error, never silently allow.
 *
 * Phase 3a scope: read-only built-in tools only (read_file, list_files,
 * codebase_search, search_files). MCP (3b) and skills/side-effecting tools (3c)
 * come later.
 */
import type { Anthropic } from "@anthropic-ai/sdk"

import type { ToolPolicy } from "@roo-code/types"

import type { Task } from "../task/Task"
import type { ToolUse, ToolResponse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import type { BaseTool, ToolCallbacks } from "../tools/BaseTool"

/** A hard tool/skill action to execute mechanically (mirrors WorkflowHardAction). */
export interface HardToolInvocation {
	type: "tool"
	name: string
	params?: Record<string, unknown>
}

/** Outcome of a mechanical invocation. */
export interface InvocationResult {
	/** The tool's result text (for feeding into workflow.advance). */
	output: string
	/** True when the tool reported an error (output is the error text). */
	isError: boolean
}

/**
 * Map a built-in tool name to its capability category. Used by the
 * `allowedCategories` permission check. Returns undefined for unknown/MCP/skill
 * names (those are handled by exact-name `allowedTools` or later phases).
 */
export function toolCategoryFor(name: string): "read" | "edit" | "command" | "mcp" | "skill" | undefined {
	switch (name) {
		case "read_file":
		case "list_files":
		case "codebase_search":
		case "search_files":
		case "web_search":
		case "web_fetch":
			return "read"
		case "write_to_file":
		case "apply_diff":
		case "edit":
		case "search_replace":
		case "edit_file":
		case "apply_patch":
			return "edit"
		case "execute_command":
		case "read_command_output":
			return "command"
		case "use_mcp_tool":
		case "access_mcp_resource":
			return "mcp"
		case "skill":
			return "skill"
		default:
			return undefined
	}
}

/** Any tool, regardless of its name type parameter (registry holds mixed tools). */
type AnyTool = BaseTool<any>

/** Dependencies injected so the invoker is testable in isolation. */
export interface HostToolInvokerDeps {
	/** Resolve a tool name to its singleton handler (undefined = not registered). */
	getTool: (name: string) => AnyTool | undefined
	/** Render a UI message for the workflow step (audit trail, §4.4). */
	say: (type: string, text: string) => Promise<void>
	/** Ask the user for approval, respecting auto-approval settings (§4.3). */
	askApproval: (type: "tool", partialMessage: string) => Promise<boolean>
}

export class HostToolInvoker {
	constructor(private readonly deps: HostToolInvokerDeps) {}

	/**
	 * Mechanically execute a hard tool action. Returns the result text (for
	 * `workflow.advance`); throws on unauthorized invocation or tool error so
	 * the caller can apply the failure policy (§5.1, default C: stop + report).
	 *
	 * The result is captured out-of-band: it does NOT enter the API conversation
	 * as a `tool_result` (there is no matching model `tool_use`).
	 */
	async invoke(
		task: Task,
		invocation: HardToolInvocation,
		policy: ToolPolicy | undefined,
	): Promise<InvocationResult> {
		const { name, params = {} } = invocation

		// 1. Permission check (§4.2). Default empty = nothing allowed.
		this.assertAllowed(name, policy)

		const tool = this.deps.getTool(name)
		if (!tool) {
			throw new Error(
				`[workflow] Tool "${name}" is not registered for mechanical invocation. ` +
					`Phase 3a supports read-only built-in tools only.`,
			)
		}

		// 2. Approval (§4.3): same askApproval as model-driven calls, labeled.
		const approvalMessage = JSON.stringify({ tool: "workflowStep", name, params })
		const approved = await this.deps.askApproval("tool", approvalMessage)
		if (!approved) {
			return { output: `Tool "${name}" was not approved.`, isError: true }
		}

		// 3. Audit trail (§4.4).
		await this.deps.say("tool", `[workflow] Mechanically executing tool: ${name} ${JSON.stringify(params)}`)

		// 4. Synthesize a ToolUse block (no model tool_use id — out-of-band).
		const block = {
			type: "tool_use" as const,
			name,
			params: params as Record<string, string>,
			nativeArgs: params,
			partial: false,
		} as ToolUse

		// 5. Inject capturing callbacks. pushToolResult MUST NOT write to
		//    task.userMessageContent — there is no matching tool_use to pair.
		let captured: ToolResponse | undefined
		let capturedError: Error | undefined
		const callbacks: ToolCallbacks = {
			askApproval: this.deps.askApproval as ToolCallbacks["askApproval"],
			handleError: async (_action: string, error: Error) => {
				capturedError = error
			},
			pushToolResult: (content: ToolResponse) => {
				captured = content
			},
		}

		await tool.handle(task, block, callbacks)

		if (capturedError) {
			throw new Error(`[workflow] Tool "${name}" failed: ${capturedError.message}`)
		}

		const output = toText(captured)
		// Detect tool-error payloads (formatResponse.toolError produces a JSON
		// string with status:"error") so the caller can apply failure policy.
		const isError = typeof output === "string" && output.includes('"status":"error"')
		return { output, isError }
	}

	/** Enforce the toolPolicy allowlist (§4.2). Throws on denial. */
	private assertAllowed(name: string, policy: ToolPolicy | undefined): void {
		const allowedTools = policy?.allowedTools
		const allowedCategories = policy?.allowedCategories

		// No policy at all = nothing allowed (fail-safe).
		if (!allowedTools && !allowedCategories) {
			throw new Error(
				`[workflow] Tool "${name}" is not allowed: the expert declares no \`toolPolicy\`. ` +
					`Add \`toolPolicy.allowedTools\` or \`toolPolicy.allowedCategories\` to authorize workflow tools.`,
			)
		}

		if (allowedTools?.includes(name)) {
			return
		}

		const category = toolCategoryFor(name)
		if (category && allowedCategories?.includes(category)) {
			return
		}

		throw new Error(
			`[workflow] Tool "${name}" is not allowed by the expert's \`toolPolicy\`. ` +
				`Allowed tools: [${allowedTools?.join(", ") ?? ""}], ` +
				`allowed categories: [${allowedCategories?.join(", ") ?? ""}].`,
		)
	}
}

/** Flatten a ToolResponse (string or content blocks) to plain text. */
function toText(content: ToolResponse | undefined): string {
	if (content === undefined) {
		return "(tool did not return anything)"
	}
	if (typeof content === "string") {
		return content || "(tool did not return anything)"
	}
	const texts = content
		.filter((block): block is Anthropic.TextBlockParam => block.type === "text")
		.map((block) => block.text)
	return texts.join("\n") || "(tool did not return anything)"
}

/**
 * Build the read-only built-in tool registry for Phase 3a. Returns a name→tool
 * lookup. Only side-effect-free tools are included so the skeleton can be
 * validated safely; side-effecting tools (3c) and MCP (3b) come later.
 */
export function buildReadOnlyToolRegistry(tools: {
	readFileTool: AnyTool
	listFilesTool: AnyTool
	codebaseSearchTool: AnyTool
	searchFilesTool: AnyTool
}): Map<string, AnyTool> {
	const map = new Map<string, AnyTool>()
	map.set("read_file", tools.readFileTool)
	map.set("list_files", tools.listFilesTool)
	map.set("codebase_search", tools.codebaseSearchTool)
	map.set("search_files", tools.searchFilesTool)
	return map
}

// Re-export formatResponse so callers can build error strings consistently.
export { formatResponse }
