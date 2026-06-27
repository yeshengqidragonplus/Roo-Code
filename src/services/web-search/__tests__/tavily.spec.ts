import { describe, it, expect, vi, beforeEach } from "vitest"
import axios from "axios"
import { tavilySearch } from "../tavily"

vi.mock("axios")

describe("tavilySearch", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("posts to the Tavily endpoint with default options and maps the response", async () => {
		vi.mocked(axios.post).mockResolvedValue({
			data: {
				answer: "Cocos Creator 3.x uses TypeScript.",
				results: [
					{ title: "Cocos Docs", url: "https://docs.cocos.com", content: "Intro to Cocos.", score: 0.9 },
				],
			},
		})

		const res = await tavilySearch({ apiKey: "key-123", query: "cocos typescript" })

		// Request shape: defaults applied, Authorization bearer header set.
		expect(axios.post).toHaveBeenCalledWith(
			"https://api.tavily.com/search",
			{
				query: "cocos typescript",
				max_results: 5,
				search_depth: "basic",
				include_answer: true,
			},
			expect.objectContaining({
				headers: expect.objectContaining({
					"Content-Type": "application/json",
					Authorization: "Bearer key-123",
				}),
				timeout: 30_000,
			}),
		)

		expect(res.answer).toBe("Cocos Creator 3.x uses TypeScript.")
		expect(res.results).toHaveLength(1)
		expect(res.results[0]).toEqual({
			title: "Cocos Docs",
			url: "https://docs.cocos.com",
			content: "Intro to Cocos.",
			score: 0.9,
		})
	})

	it("includes include_domains only when a non-empty array is provided", async () => {
		vi.mocked(axios.post).mockResolvedValue({ data: { results: [] } })

		await tavilySearch({
			apiKey: "k",
			query: "q",
			includeDomains: ["docs.godotengine.org", "godotengine.org"],
		})

		const body = vi.mocked(axios.post).mock.calls[0][1] as Record<string, unknown>
		expect(body).toHaveProperty("include_domains", ["docs.godotengine.org", "godotengine.org"])
	})

	it("omits include_domains when the array is empty", async () => {
		vi.mocked(axios.post).mockResolvedValue({ data: { results: [] } })

		await tavilySearch({ apiKey: "k", query: "q", includeDomains: [] })

		const body = vi.mocked(axios.post).mock.calls[0][1] as Record<string, unknown>
		expect(body).not.toHaveProperty("include_domains")
	})

	it("omits include_domains when undefined", async () => {
		vi.mocked(axios.post).mockResolvedValue({ data: { results: [] } })

		await tavilySearch({ apiKey: "k", query: "q" })

		const body = vi.mocked(axios.post).mock.calls[0][1] as Record<string, unknown>
		expect(body).not.toHaveProperty("include_domains")
	})

	it("honors custom maxResults and searchDepth", async () => {
		vi.mocked(axios.post).mockResolvedValue({ data: { results: [] } })

		await tavilySearch({ apiKey: "k", query: "q", maxResults: 10, searchDepth: "advanced" })

		const body = vi.mocked(axios.post).mock.calls[0][1] as Record<string, unknown>
		expect(body).toMatchObject({ max_results: 10, search_depth: "advanced" })
	})

	it("can disable the synthesized answer", async () => {
		vi.mocked(axios.post).mockResolvedValue({ data: { results: [] } })

		await tavilySearch({ apiKey: "k", query: "q", includeAnswer: false })

		const body = vi.mocked(axios.post).mock.calls[0][1] as Record<string, unknown>
		expect(body).toMatchObject({ include_answer: false })
	})

	it("coerces missing/odd result fields to safe defaults", async () => {
		vi.mocked(axios.post).mockResolvedValue({
			data: {
				// answer absent -> undefined
				results: [
					{
						/* no fields */
					},
					{ title: 123, url: null, content: false, score: "high" },
				],
			},
		})

		const res = await tavilySearch({ apiKey: "k", query: "q" })

		expect(res.answer).toBeUndefined()
		expect(res.results).toHaveLength(2)
		expect(res.results[0]).toEqual({ title: "", url: "", content: "", score: undefined })
		// String() coerces non-string fields; null url falls to "" via ??; non-number score -> undefined.
		expect(res.results[1]).toEqual({ title: "123", url: "", content: "false", score: undefined })
	})

	it("returns empty results array when the API response has no results field", async () => {
		vi.mocked(axios.post).mockResolvedValue({ data: { answer: "only an answer" } })

		const res = await tavilySearch({ apiKey: "k", query: "q" })

		expect(res.answer).toBe("only an answer")
		expect(res.results).toEqual([])
	})

	it("returns undefined answer when the API response answer is not a string", async () => {
		vi.mocked(axios.post).mockResolvedValue({ data: { answer: 42, results: [] } })

		const res = await tavilySearch({ apiKey: "k", query: "q" })

		expect(res.answer).toBeUndefined()
	})

	it("forwards the AbortSignal to axios", async () => {
		vi.mocked(axios.post).mockResolvedValue({ data: { results: [] } })
		const controller = new AbortController()

		await tavilySearch({ apiKey: "k", query: "q", signal: controller.signal })

		const config = vi.mocked(axios.post).mock.calls[0][2] as { signal: AbortSignal }
		expect(config.signal).toBe(controller.signal)
	})

	it("propagates axios errors", async () => {
		const error = new Error("Unauthorized")
		vi.mocked(axios.post).mockRejectedValue(error)

		await expect(tavilySearch({ apiKey: "bad", query: "q" })).rejects.toThrow("Unauthorized")
	})
})
