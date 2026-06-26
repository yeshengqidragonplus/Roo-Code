import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fetchAndExtract } from "../../services/web-search/extract"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import type { SingleCompletionHandler } from "../../api"
import type { ToolUse, NativeToolArgs } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

// Only distill when a prompt is given AND the page is long enough that raw text would be wasteful.
const DISTILL_MIN_CHARS = 3_000
// Read more of the page when we're going to distill it down against a prompt.
const DISTILL_FETCH_CHARS = 50_000

export class WebFetchTool extends BaseTool<"web_fetch"> {
	readonly name = "web_fetch" as const

	async execute(params: NativeToolArgs["web_fetch"], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { url } = params
		const prompt = params.prompt ?? undefined

		const provider = task.providerRef.deref()
		const state = await provider?.getState()

		if (!experiments.isEnabled(state?.experiments ?? {}, EXPERIMENT_IDS.WEB_SEARCH)) {
			pushToolResult(
				formatResponse.toolError(
					"Web access is an experimental feature that must be enabled in settings. Enable 'Web Search' in the Experimental Settings section.",
				),
			)
			return
		}

		if (!url) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_fetch")
			pushToolResult(await task.sayAndCreateMissingParamError("web_fetch", "url"))
			return
		}

		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			pushToolResult(formatResponse.toolError(`Invalid URL: ${url}`))
			return
		}

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			pushToolResult(formatResponse.toolError(`Only http(s) URLs are supported. Got: ${parsed.protocol}`))
			return
		}

		const didApprove = await askApproval("tool", JSON.stringify({ tool: "webFetch", url }))
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		task.consecutiveMistakeCount = 0

		const shouldDistill = !!prompt
		try {
			const page = await fetchAndExtract({
				url,
				maxChars: shouldDistill ? DISTILL_FETCH_CHARS : undefined,
			})

			task.recordToolUsage("web_fetch")

			if (!page.content) {
				pushToolResult(`Fetched ${url} but found no readable text content.`)
				return
			}

			// Distill long pages against the caller's prompt so the model gets the
			// relevant answer rather than a truncated wall of text.
			if (shouldDistill && page.content.length >= DISTILL_MIN_CHARS) {
				const distilled = await this.distill(task, prompt!, page.title, page.url, page.content)
				if (distilled) {
					pushToolResult(
						[`URL: ${page.url}`, page.title ? `Title: ${page.title}` : "", ``, distilled]
							.filter(Boolean)
							.join("\n"),
					)
					return
				}
				// Fall through to raw content if distillation was unavailable or failed.
			}

			const output = [
				page.title ? `Title: ${page.title}` : "",
				`URL: ${page.url}`,
				page.truncated ? `(content truncated)` : "",
				``,
				page.content,
			]
				.filter(Boolean)
				.join("\n")

			pushToolResult(output)
		} catch (error: any) {
			await handleError("web_fetch", error)
		}
	}

	/**
	 * Compress a fetched page down to just what answers `prompt`, using the task's
	 * configured model. Returns undefined if the handler can't do single completions
	 * or the call fails, so the caller can fall back to raw text.
	 */
	private async distill(
		task: Task,
		prompt: string,
		title: string,
		url: string,
		content: string,
	): Promise<string | undefined> {
		const handler = task.api as Partial<SingleCompletionHandler>
		if (typeof handler.completePrompt !== "function") {
			return undefined
		}

		const distillPrompt = `You are extracting information from a fetched web page.

Page title: ${title || "(none)"}
Page URL: ${url}

The user wants: ${prompt}

Below is the page's cleaned text content. Extract and concisely summarize ONLY the information relevant to what the user wants. Preserve exact code snippets, signatures, commands, and version numbers verbatim. If the page does not contain the answer, say so plainly.

--- PAGE CONTENT START ---
${content}
--- PAGE CONTENT END ---`

		try {
			const result = await handler.completePrompt(distillPrompt)
			const trimmed = result?.trim()
			return trimmed ? trimmed : undefined
		} catch (error) {
			console.error("web_fetch distillation failed, falling back to raw content:", error)
			return undefined
		}
	}

	override async handlePartial(_task: Task, _block: ToolUse<"web_fetch">): Promise<void> {
		return
	}
}

export const webFetchTool = new WebFetchTool()
