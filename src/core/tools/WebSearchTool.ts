import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { tavilySearch } from "../../services/web-search/tavily"
import { googleSearch } from "../../services/web-search/google"
import { bingSearch } from "../../services/web-search/bing"
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
					"Web search is an experimental feature that must be enabled in settings. Enable 'Web Search' in the Experimental Settings section and configure a search backend (DuckDuckGo, Tavily or Google).",
				),
			)
			return
		}

		// --- Backend selection -------------------------------------------------
		// webSearchProvider: "bing" | "tavily" | "google" | "auto" (default "auto").
		// "auto" prefers the free Bing backend, then Google/Tavily when
		// credentials are present.
		const webSearchProvider = state?.webSearchProvider ?? "auto"
		const tavilyKey = state?.tavilyApiKey
		const googleKey = state?.googleApiKey
		const googleCx = state?.googleCseId

		const googleReady = !!(googleKey && googleCx)
		const tavilyReady = !!tavilyKey
		// Bing HTML scraping needs no credentials — always ready.
		const bingReady = true

		type Backend = "bing" | "google" | "tavily"
		let backend: Backend
		switch (webSearchProvider) {
			case "google":
				backend = "google"
				break
			case "tavily":
				backend = "tavily"
				break
			case "bing":
				backend = "bing"
				break
			default:
				// auto: prefer free Bing, then Google, then Tavily.
				backend = bingReady ? "bing" : googleReady ? "google" : "tavily"
				break
		}

		// Validate credentials for the chosen / auto-resolved backend.
		if (backend === "google" && !googleReady) {
			pushToolResult(
				formatResponse.toolError(
					"Web search is set to use Google but the Google API key or Custom Search Engine ID (cx) is missing. " +
						"Add them in the Web Search settings, or switch to Bing (free, no key needed).",
				),
			)
			return
		}
		if (backend === "tavily" && !tavilyReady) {
			pushToolResult(
				formatResponse.toolError(
					"Web search is set to use Tavily but no API key is configured. " +
						"Add a Tavily API key in the Web Search settings, or switch to Bing (free, no key needed).",
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
			// --- Execute the chosen backend ------------------------------------
			let results: { title: string; url: string; content: string }[]
			let answer: string | undefined

			if (backend === "google") {
				const googleResults = await googleSearch({
					apiKey: googleKey!,
					cseId: googleCx!,
					query,
					maxResults,
					includeDomains: allowedDomains,
				})
				results = googleResults.results
				// Google CSE does not synthesize an answer; leave it undefined.
				answer = undefined
			} else if (backend === "bing") {
				const bingResponse = await bingSearch({
					query,
					maxResults,
					includeDomains: allowedDomains,
				})
				results = bingResponse.results
				// Bing HTML scraping does not synthesize an answer.
				answer = undefined
			} else {
				const tavilyResponse = await tavilySearch({
					apiKey: tavilyKey!,
					query,
					maxResults,
					includeDomains: allowedDomains,
				})
				results = tavilyResponse.results
				answer = tavilyResponse.answer
			}

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
