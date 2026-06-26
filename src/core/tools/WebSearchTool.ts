import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { tavilySearch } from "../../services/web-search/tavily"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import type { ToolUse, NativeToolArgs } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

export class WebSearchTool extends BaseTool<"web_search"> {
	readonly name = "web_search" as const

	async execute(params: NativeToolArgs["web_search"], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { query } = params
		const maxResults = params.max_results ?? undefined
		const allowedDomains = params.allowed_domains ?? undefined

		const provider = task.providerRef.deref()
		const state = await provider?.getState()

		if (!experiments.isEnabled(state?.experiments ?? {}, EXPERIMENT_IDS.WEB_SEARCH)) {
			pushToolResult(
				formatResponse.toolError(
					"Web search is an experimental feature that must be enabled in settings. Enable 'Web Search' in the Experimental Settings section and set a Tavily API key.",
				),
			)
			return
		}

		const apiKey = state?.tavilyApiKey
		if (!apiKey) {
			pushToolResult(
				formatResponse.toolError(
					"Web search requires a Tavily API key. Add it in the Web Search settings (https://tavily.com).",
				),
			)
			return
		}

		if (!query) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_search")
			pushToolResult(await task.sayAndCreateMissingParamError("web_search", "query"))
			return
		}

		const didApprove = await askApproval(
			"tool",
			JSON.stringify({ tool: "webSearch", query, ...(allowedDomains ? { allowedDomains } : {}) }),
		)
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		task.consecutiveMistakeCount = 0

		try {
			const { answer, results } = await tavilySearch({
				apiKey,
				query,
				maxResults,
				includeDomains: allowedDomains,
			})

			task.recordToolUsage("web_search")

			if (results.length === 0) {
				pushToolResult(`No web results found for the query: "${query}"`)
				return
			}

			const formattedResults = results
				.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content.replace(/\n+/g, " ").trim()}`)
				.join("\n\n")

			const output = [
				`Query: ${query}`,
				answer ? `\nAnswer (synthesized): ${answer}` : "",
				`\nResults:\n\n${formattedResults}`,
				`\n\nUse web_fetch with a result URL to read its full content.`,
			]
				.filter(Boolean)
				.join("\n")

			pushToolResult(output)
		} catch (error: any) {
			await handleError("web_search", error)
		}
	}

	override async handlePartial(_task: Task, _block: ToolUse<"web_search">): Promise<void> {
		return
	}
}

export const webSearchTool = new WebSearchTool()
