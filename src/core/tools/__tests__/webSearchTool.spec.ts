import { describe, it, expect, vi, beforeEach } from "vitest"
import { webSearchTool } from "../WebSearchTool"
import { ToolUse } from "../../../shared/tools"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { EXPERIMENT_IDS } from "../../../shared/experiments"
import * as tavily from "../../../services/web-search/tavily"
import * as google from "../../../services/web-search/google"

vi.mock("../../../services/web-search/tavily")
vi.mock("../../../services/web-search/google")

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
					"Web search is an experimental feature that must be enabled in settings. Enable 'Web Search' in the Experimental Settings section and configure a search backend (Tavily or Google).",
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
					"Web search is an experimental feature that must be enabled in settings. Enable 'Web Search' in the Experimental Settings section and configure a search backend (Tavily or Google).",
				),
			)
			expect(vi.mocked(tavily.tavilySearch)).not.toHaveBeenCalled()
		})
	})

	describe("api key validation", () => {
		it("errors when no backend credentials are configured", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: true },
				tavilyApiKey: undefined,
				googleApiKey: undefined,
				googleCseId: undefined,
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError(
					"Web search requires a Tavily API key (or Google API key + CSE ID). " +
						"Add credentials in the Web Search settings.",
				),
			)
			expect(vi.mocked(tavily.tavilySearch)).not.toHaveBeenCalled()
		})

		it("errors when webSearchProvider is google but credentials are missing", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: true },
				tavilyApiKey: "tavily-key",
				googleApiKey: undefined,
				googleCseId: undefined,
				webSearchProvider: "google",
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError(
					"Web search is set to use Google but the Google API key or Custom Search Engine ID (cx) is missing. " +
						"Add them in the Web Search settings, or switch to Tavily.",
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

	describe("successful search (tavily)", () => {
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

		it("returns a no-results message when results array is empty", async () => {
			vi.mocked(tavily.tavilySearch).mockResolvedValue({ results: [] })

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "nothing" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith('No web results found for the query: "nothing"')
		})
	})

	describe("successful search (google)", () => {
		it("uses googleSearch when webSearchProvider is google and credentials are present", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: true },
				googleApiKey: "google-key",
				googleCseId: "cx-id",
				webSearchProvider: "google",
			})
			vi.mocked(google.googleSearch).mockResolvedValue({
				results: [
					{ title: "Unity", url: "https://unity.com", content: "Unity is an engine." },
					{ title: "Unreal", url: "https://unreal.com", content: "Unreal is powerful." },
				],
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "game engines" }), callbacks())

			expect(vi.mocked(google.googleSearch)).toHaveBeenCalledWith({
				apiKey: "google-key",
				cseId: "cx-id",
				query: "game engines",
				maxResults: undefined,
				includeDomains: undefined,
			})
			expect(vi.mocked(tavily.tavilySearch)).not.toHaveBeenCalled()
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("web_search")

			const output = mockPushToolResult.mock.calls[0][0] as string
			expect(output).toContain("Query: game engines")
			// Google does not synthesize an answer.
			expect(output).not.toContain("Answer (synthesized)")
			expect(output).toContain("1. Unity")
			expect(output).toContain("URL: https://unity.com")
			expect(output).toContain("Unity is an engine.")
			expect(output).toContain("2. Unreal")
			// HTML tags stripped from snippets.
			expect(output).toContain("Unreal is powerful.")
		})

		it("auto-selects google when google credentials are present and no provider is set", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: true },
				googleApiKey: "google-key",
				googleCseId: "cx-id",
				// webSearchProvider unset -> "auto" -> prefers google
			})
			vi.mocked(google.googleSearch).mockResolvedValue({
				results: [{ title: "R", url: "https://r", content: "c" }],
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(vi.mocked(google.googleSearch)).toHaveBeenCalled()
			expect(vi.mocked(tavily.tavilySearch)).not.toHaveBeenCalled()
		})

		it("falls back to tavily when provider is auto and only tavily credentials are present", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: true },
				tavilyApiKey: "tavily-key",
				// google creds absent
			})
			vi.mocked(tavily.tavilySearch).mockResolvedValue({
				results: [{ title: "T", url: "https://u", content: "c" }],
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(vi.mocked(tavily.tavilySearch)).toHaveBeenCalled()
			expect(vi.mocked(google.googleSearch)).not.toHaveBeenCalled()
		})

		it("forces tavily when webSearchProvider is tavily even if google creds are present", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: true },
				tavilyApiKey: "tavily-key",
				googleApiKey: "google-key",
				googleCseId: "cx-id",
				webSearchProvider: "tavily",
			})
			vi.mocked(tavily.tavilySearch).mockResolvedValue({
				results: [{ title: "T", url: "https://u", content: "c" }],
			})

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(vi.mocked(tavily.tavilySearch)).toHaveBeenCalled()
			expect(vi.mocked(google.googleSearch)).not.toHaveBeenCalled()
		})
	})

	describe("error handling", () => {
		it("calls handleError when the search backend throws", async () => {
			vi.mocked(tavily.tavilySearch).mockRejectedValue(new Error("Network error"))

			await webSearchTool.handle(mockTask as Task, makeBlock({ query: "q" }), callbacks())

			expect(mockHandleError).toHaveBeenCalledWith("web_search", expect.any(Error))
		})
	})
})
