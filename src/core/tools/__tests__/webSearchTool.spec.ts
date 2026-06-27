import { describe, it, expect, vi, beforeEach } from "vitest"
import { webSearchTool } from "../WebSearchTool"
import { ToolUse } from "../../../shared/tools"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { EXPERIMENT_IDS } from "../../../shared/experiments"
import * as tavily from "../../../services/web-search/tavily"

vi.mock("../../../services/web-search/tavily")

describe("webSearchTool", () => {
	let mockTask: any
	let mockAskApproval: any
	let mockHandleError: any
	let mockPushToolResult: any

	const makeBlock = (nativeArgs: Record<string, unknown>): ToolUse<"web_search"> =>
		({
			type: "tool_use",
			name: "web_search",
			params: nativeArgs,
			nativeArgs,
			partial: false,
		}) as ToolUse<"web_search">

	const callbacks = () => ({
		askApproval: mockAskApproval,
		handleError: mockHandleError,
		pushToolResult: mockPushToolResult,
	})

	beforeEach(() => {
		vi.clearAllMocks()

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			recordToolUsage: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: true },
						tavilyApiKey: "tavily-key",
					}),
				}),
			},
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn()
		mockPushToolResult = vi.fn()
	})

	describe("experiment gating", () => {
		it("errors when the web search experiment is disabled", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: false },
				tavilyApiKey: "tavily-key",
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError(
					"Web search is an experimental feature that must be enabled in settings. Enable 'Web Search' in the Experimental Settings section and set a Tavily API key.",
				),
			)
			expect(vi.mocked(tavily.tavilySearch)).not.toHaveBeenCalled()
		})

		it("errors when the experiment config is absent (defaults to disabled)", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: {},
				tavilyApiKey: "tavily-key",
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			// Absent config falls back to the disabled default -> same gating error.
			expect(mockPushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError(
					"Web search is an experimental feature that must be enabled in settings. Enable 'Web Search' in the Experimental Settings section and set a Tavily API key.",
				),
			)
			expect(vi.mocked(tavily.tavilySearch)).not.toHaveBeenCalled()
		})
	})

	describe("api key validation", () => {
		it("errors when no Tavily API key is configured", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: true },
				tavilyApiKey: undefined,
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError(
					"Web search requires a Tavily API key. Add it in the Web Search settings (https://tavily.com).",
				),
			)
			expect(vi.mocked(tavily.tavilySearch)).not.toHaveBeenCalled()
		})
	})

	describe("missing parameter", () => {
		it("records a mistake and surfaces a missing-param error when query is empty", async () => {
			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "" }), callbacks())

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("web_search")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("web_search", "query")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing parameter error")
			expect(mockAskApproval).not.toHaveBeenCalled()
		})
	})

	describe("approval", () => {
		it("asks for approval with the query and allowedDomains", async () => {
			vi.mocked(tavily.tavilySearch).mockResolvedValue({ results: [] })

			await webSearchTool.handle(
				mockTask as Task,
				makeBlock({ query: "cocos creator", allowed_domains: ["docs.cocos.com"] }),
				callbacks(),
			)

			expect(mockAskApproval).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "webSearch", query: "cocos creator", allowedDomains: ["docs.cocos.com"] }),
			)
		})

		it("omits allowedDomains from the approval payload when not provided", async () => {
			vi.mocked(tavily.tavilySearch).mockResolvedValue({ results: [] })

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(mockAskApproval).toHaveBeenCalledWith("tool", JSON.stringify({ tool: "webSearch", query: "q" }))
		})

		it("denies and returns toolDenied when approval is refused", async () => {
			mockAskApproval.mockResolvedValue(false)

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(formatResponse.toolDenied())
			expect(vi.mocked(tavily.tavilySearch)).not.toHaveBeenCalled()
		})

		it("resets consecutiveMistakeCount after approval", async () => {
			mockTask.consecutiveMistakeCount = 3
			vi.mocked(tavily.tavilySearch).mockResolvedValue({ results: [] })

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(mockTask.consecutiveMistakeCount).toBe(0)
		})
	})

	describe("successful search", () => {
		it("formats results with title, url, and content, and records usage", async () => {
			vi.mocked(tavily.tavilySearch).mockResolvedValue({
				answer: "It is a game engine.",
				results: [
					{ title: "Cocos", url: "https://cocos.com", content: "Cocos Creator is an engine." },
					{ title: "Godot", url: "https://godot.com", content: "Godot is free.\nOpen source." },
				],
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "game engines" }), callbacks())

			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("web_search")
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			const output = mockPushToolResult.mock.calls[0][0] as string

			expect(output).toContain("Query: game engines")
			expect(output).toContain("Answer (synthesized): It is a game engine.")
			expect(output).toContain("1. Cocos")
			expect(output).toContain("URL: https://cocos.com")
			expect(output).toContain("Cocos Creator is an engine.")
			expect(output).toContain("2. Godot")
			// Newlines inside content snippets are collapsed to spaces.
			expect(output).toContain("Godot is free. Open source.")
			expect(output).toContain("Use web_fetch with a result URL to read its full content.")
		})

		it("omits the synthesized answer line when none is returned", async () => {
			vi.mocked(tavily.tavilySearch).mockResolvedValue({
				results: [{ title: "T", url: "https://u", content: "c" }],
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			const output = mockPushToolResult.mock.calls[0][0] as string
			expect(output).not.toContain("Answer (synthesized)")
		})

		it("forwards max_results and allowed_domains to tavilySearch", async () => {
			vi.mocked(tavily.tavilySearch).mockResolvedValue({ results: [] })

			await webSearchTool.handle(
				mockTask as Task,
				makeBlock({ query: "q", max_results: 7, allowed_domains: ["a.com", "b.com"] }),
				callbacks(),
			)

			expect(vi.mocked(tavily.tavilySearch)).toHaveBeenCalledWith({
				apiKey: "tavily-key",
				query: "q",
				maxResults: 7,
				includeDomains: ["a.com", "b.com"],
			})
		})
	})

	describe("empty results", () => {
		it("returns a no-results message (usage is still recorded before the empty check)", async () => {
			vi.mocked(tavily.tavilySearch).mockResolvedValue({ results: [] })

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "obscure query" }), callbacks())

			// recordToolUsage runs before the empty-results branch.
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("web_search")
			expect(mockPushToolResult).toHaveBeenCalledWith('No web results found for the query: "obscure query"')
		})
	})

	describe("error handling", () => {
		it("delegates to handleError when tavilySearch throws", async () => {
			const error = new Error("Tavily down")
			vi.mocked(tavily.tavilySearch).mockRejectedValue(error)

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(mockHandleError).toHaveBeenCalledWith("web_search", error)
			expect(mockPushToolResult).not.toHaveBeenCalled()
		})
	})

	describe("partial block", () => {
		it("does nothing when the block is partial", async () => {
			const partialBlock = {
				type: "tool_use",
				name: "web_search",
				params: { query: "q" },
				nativeArgs: { query: "q" },
				partial: true,
			} as ToolUse<"web_search">

			await webSearchTool.handle(mockTask as Task, partialBlock, callbacks())

			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalled()
			expect(vi.mocked(tavily.tavilySearch)).not.toHaveBeenCalled()
		})
	})
})
