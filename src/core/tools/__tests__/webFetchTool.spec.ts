import { describe, it, expect, vi, beforeEach } from "vitest"
import { webFetchTool } from "../WebFetchTool"
import { ToolUse } from "../../../shared/tools"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { EXPERIMENT_IDS } from "../../../shared/experiments"
import * as extract from "../../../services/web-search/extract"

vi.mock("../../../services/web-search/extract")

describe("webFetchTool", () => {
	let mockTask: any
	let mockAskApproval: any
	let mockHandleError: any
	let mockPushToolResult: any

	const makeBlock = (nativeArgs: Record<string, unknown>): ToolUse<"web_fetch"> =>
		({
			type: "tool_use",
			name: "web_fetch",
			params: nativeArgs,
			nativeArgs,
			partial: false,
		}) as ToolUse<"web_fetch">

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
					}),
				}),
			},
			api: {},
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn()
		mockPushToolResult = vi.fn()
	})

	describe("experiment gating", () => {
		it("errors when the web search experiment is disabled", async () => {
			mockTask.providerRef.deref().getState.mockResolvedValue({
				experiments: { [EXPERIMENT_IDS.WEB_SEARCH]: false },
			})

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError(
					"Web access is an experimental feature that must be enabled in settings. Enable 'Web Search' in the Experimental Settings section.",
				),
			)
			expect(vi.mocked(extract.fetchAndExtract)).not.toHaveBeenCalled()
		})
	})

	describe("missing parameter", () => {
		it("records a mistake and surfaces a missing-param error when url is empty", async () => {
			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "" }), callbacks())

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("web_fetch")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("web_fetch", "url")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing parameter error")
			expect(mockAskApproval).not.toHaveBeenCalled()
		})
	})

	describe("URL validation", () => {
		it("errors on an unparseable URL", async () => {
			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "not a url" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(formatResponse.toolError("Invalid URL: not a url"))
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(vi.mocked(extract.fetchAndExtract)).not.toHaveBeenCalled()
		})

		it("errors on a non-http(s) protocol", async () => {
			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "ftp://example.com/file" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError("Only http(s) URLs are supported. Got: ftp:"),
			)
			expect(vi.mocked(extract.fetchAndExtract)).not.toHaveBeenCalled()
		})

		it("errors on a file:// URL", async () => {
			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "file:///etc/passwd" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError("Only http(s) URLs are supported. Got: file:"),
			)
		})
	})

	describe("approval", () => {
		it("asks for approval with the url", async () => {
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "T",
				content: "c",
				truncated: false,
			})

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com" }), callbacks())

			expect(mockAskApproval).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "webFetch", url: "https://example.com" }),
			)
		})

		it("denies and returns toolDenied when approval is refused", async () => {
			mockAskApproval.mockResolvedValue(false)

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(formatResponse.toolDenied())
			expect(vi.mocked(extract.fetchAndExtract)).not.toHaveBeenCalled()
		})

		it("resets consecutiveMistakeCount after approval", async () => {
			mockTask.consecutiveMistakeCount = 2
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "T",
				content: "c",
				truncated: false,
			})

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com" }), callbacks())

			expect(mockTask.consecutiveMistakeCount).toBe(0)
		})
	})

	describe("successful fetch without distillation", () => {
		it("returns title, url, and content; records usage", async () => {
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com/page",
				title: "Example Page",
				content: "Some readable content.",
				truncated: false,
			})

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com/page" }), callbacks())

			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("web_fetch")
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			const output = mockPushToolResult.mock.calls[0][0] as string

			expect(output).toContain("Title: Example Page")
			expect(output).toContain("URL: https://example.com/page")
			expect(output).toContain("Some readable content.")
			expect(output).not.toContain("(content truncated)")
		})

		it("includes a truncation marker when the page was truncated", async () => {
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "Big",
				content: "x".repeat(100),
				truncated: true,
			})

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com" }), callbacks())

			const output = mockPushToolResult.mock.calls[0][0] as string
			expect(output).toContain("(content truncated)")
		})

		it("omits the title line when the page has no title", async () => {
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "",
				content: "content only",
				truncated: false,
			})

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com" }), callbacks())

			const output = mockPushToolResult.mock.calls[0][0] as string
			expect(output).not.toContain("Title:")
			expect(output).toContain("content only")
		})

		it("returns a no-content message when the page has no readable text", async () => {
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "Empty",
				content: "",
				truncated: false,
			})

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com" }), callbacks())

			expect(mockPushToolResult).toHaveBeenCalledWith(
				"Fetched https://example.com but found no readable text content.",
			)
		})

		it("does not distill a short page even when a prompt is given", async () => {
			// Below the DISTILL_MIN_CHARS (3000) threshold.
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "Short",
				content: "short content",
				truncated: false,
			})
			mockTask.api.completePrompt = vi.fn()

			await webFetchTool.handle(
				mockTask as Task,
				makeBlock({ url: "https://example.com", prompt: "summarize" }),
				callbacks(),
			)

			// Short page -> no distillation, raw content returned.
			expect(mockTask.api.completePrompt).not.toHaveBeenCalled()
			const output = mockPushToolResult.mock.calls[0][0] as string
			expect(output).toContain("short content")
		})
	})

	describe("distillation", () => {
		it("distills a long page against the prompt when completePrompt is available", async () => {
			// Above the DISTILL_MIN_CHARS (3000) threshold.
			const longContent = "A".repeat(4000)
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "Long Page",
				content: longContent,
				truncated: false,
			})
			mockTask.api.completePrompt = vi.fn().mockResolvedValue("Distilled answer.")

			await webFetchTool.handle(
				mockTask as Task,
				makeBlock({ url: "https://example.com", prompt: "what is this about" }),
				callbacks(),
			)

			expect(mockTask.api.completePrompt).toHaveBeenCalledTimes(1)
			// The distill prompt embeds the user's prompt and the page content.
			const distillPrompt = mockTask.api.completePrompt.mock.calls[0][0] as string
			expect(distillPrompt).toContain("what is this about")
			expect(distillPrompt).toContain(longContent)

			const output = mockPushToolResult.mock.calls[0][0] as string
			expect(output).toContain("Distilled answer.")
			// Raw content is not returned when distillation succeeds.
			expect(output).not.toContain(longContent)
		})

		it("falls back to raw content when completePrompt is not available", async () => {
			const longContent = "B".repeat(4000)
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "Long",
				content: longContent,
				truncated: false,
			})
			// No completePrompt on the api object.

			await webFetchTool.handle(
				mockTask as Task,
				makeBlock({ url: "https://example.com", prompt: "summarize" }),
				callbacks(),
			)

			const output = mockPushToolResult.mock.calls[0][0] as string
			expect(output).toContain(longContent)
		})

		it("falls back to raw content when distillation throws", async () => {
			const longContent = "C".repeat(4000)
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "Long",
				content: longContent,
				truncated: false,
			})
			mockTask.api.completePrompt = vi.fn().mockRejectedValue(new Error("model down"))

			await webFetchTool.handle(
				mockTask as Task,
				makeBlock({ url: "https://example.com", prompt: "summarize" }),
				callbacks(),
			)

			const output = mockPushToolResult.mock.calls[0][0] as string
			expect(output).toContain(longContent)
		})

		it("falls back to raw content when distillation returns empty", async () => {
			const longContent = "D".repeat(4000)
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "Long",
				content: longContent,
				truncated: false,
			})
			mockTask.api.completePrompt = vi.fn().mockResolvedValue("   ")

			await webFetchTool.handle(
				mockTask as Task,
				makeBlock({ url: "https://example.com", prompt: "summarize" }),
				callbacks(),
			)

			const output = mockPushToolResult.mock.calls[0][0] as string
			expect(output).toContain(longContent)
		})

		it("requests a larger fetch budget when distilling (DISTILL_FETCH_CHARS)", async () => {
			const longContent = "E".repeat(4000)
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "Long",
				content: longContent,
				truncated: false,
			})
			mockTask.api.completePrompt = vi.fn().mockResolvedValue("distilled")

			await webFetchTool.handle(
				mockTask as Task,
				makeBlock({ url: "https://example.com", prompt: "summarize" }),
				callbacks(),
			)

			expect(vi.mocked(extract.fetchAndExtract)).toHaveBeenCalledWith({
				url: "https://example.com",
				maxChars: 50_000,
			})
		})

		it("does not request a custom fetch budget when no prompt is given", async () => {
			vi.mocked(extract.fetchAndExtract).mockResolvedValue({
				url: "https://example.com",
				title: "T",
				content: "c",
				truncated: false,
			})

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com" }), callbacks())

			expect(vi.mocked(extract.fetchAndExtract)).toHaveBeenCalledWith({
				url: "https://example.com",
				maxChars: undefined,
			})
		})
	})

	describe("error handling", () => {
		it("delegates to handleError when fetchAndExtract throws", async () => {
			const error = new Error("Network error")
			vi.mocked(extract.fetchAndExtract).mockRejectedValue(error)

			await webFetchTool.handle(mockTask as Task, makeBlock({ url: "https://example.com" }), callbacks())

			expect(mockHandleError).toHaveBeenCalledWith("web_fetch", error)
			expect(mockPushToolResult).not.toHaveBeenCalled()
		})
	})

	describe("partial block", () => {
		it("does nothing when the block is partial", async () => {
			const partialBlock = {
				type: "tool_use",
				name: "web_fetch",
				params: { url: "https://example.com" },
				nativeArgs: { url: "https://example.com" },
				partial: true,
			} as ToolUse<"web_fetch">

			await webFetchTool.handle(mockTask as Task, partialBlock, callbacks())

			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalled()
			expect(vi.mocked(extract.fetchAndExtract)).not.toHaveBeenCalled()
		})
	})
})
