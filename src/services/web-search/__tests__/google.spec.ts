import { describe, it, expect, vi, beforeEach } from "vitest"
import axios from "axios"
import { googleSearch } from "../google"

vi.mock("axios")

describe("googleSearch", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("constructs the request with key, cx, q, and num params", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: { items: [] },
		})

		await googleSearch({
			apiKey: "test-key",
			cseId: "test-cx",
			query: "game engines",
			maxResults: 5,
		})

		expect(axios.get).toHaveBeenCalledWith(
			"https://www.googleapis.com/customsearch/v1",
			expect.objectContaining({
				params: expect.objectContaining({
					key: "test-key",
					cx: "test-cx",
					q: "game engines",
					num: "5",
				}),
				timeout: 30_000,
			}),
		)
	})

	it("caps maxResults at 10", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { items: [] } })

		await googleSearch({
			apiKey: "k",
			cseId: "cx",
			query: "q",
			maxResults: 20,
		})

		const call = vi.mocked(axios.get).mock.calls[0]
		expect(call[1]?.params?.num).toBe("10")
	})

	it("defaults maxResults to 5 when not provided", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { items: [] } })

		await googleSearch({
			apiKey: "k",
			cseId: "cx",
			query: "q",
		})

		const call = vi.mocked(axios.get).mock.calls[0]
		expect(call[1]?.params?.num).toBe("5")
	})

	it("includes site filter in hq param when includeDomains is provided", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { items: [] } })

		await googleSearch({
			apiKey: "k",
			cseId: "cx",
			query: "q",
			includeDomains: ["docs.unity3d.com", "docs.godotengine.org"],
		})

		const call = vi.mocked(axios.get).mock.calls[0]
		expect(call[1]?.params?.hq).toBe("site:docs.unity3d.com OR site:docs.godotengine.org")
	})

	it("omits hq param when includeDomains is empty", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { items: [] } })

		await googleSearch({
			apiKey: "k",
			cseId: "cx",
			query: "q",
			includeDomains: [],
		})

		const call = vi.mocked(axios.get).mock.calls[0]
		expect(call[1]?.params?.hq).toBeUndefined()
	})

	it("maps API response items to title/url/content", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				items: [
					{ title: "Unity", link: "https://unity.com", snippet: "Unity is an engine." },
					{ title: "Godot", link: "https://godot.com", snippet: "Godot is free." },
				],
			},
		})

		const { results } = await googleSearch({
			apiKey: "k",
			cseId: "cx",
			query: "q",
		})

		expect(results).toHaveLength(2)
		expect(results[0]).toEqual({
			title: "Unity",
			url: "https://unity.com",
			content: "Unity is an engine.",
		})
		expect(results[1]).toEqual({
			title: "Godot",
			url: "https://godot.com",
			content: "Godot is free.",
		})
	})

	it("strips HTML tags from snippets", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				items: [{ title: "T", link: "https://u", snippet: "Hello <b>world</b> & <i>foo</i>" }],
			},
		})

		const { results } = await googleSearch({
			apiKey: "k",
			cseId: "cx",
			query: "q",
		})

		expect(results[0].content).toBe("Hello world & foo")
	})

	it("handles missing items array gracefully", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: {} })

		const { results } = await googleSearch({
			apiKey: "k",
			cseId: "cx",
			query: "q",
		})

		expect(results).toEqual([])
	})

	it("handles items with missing fields gracefully", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				items: [{}, { title: "T" }],
			},
		})

		const { results } = await googleSearch({
			apiKey: "k",
			cseId: "cx",
			query: "q",
		})

		expect(results).toHaveLength(2)
		expect(results[0]).toEqual({ title: "", url: "", content: "" })
		expect(results[1]).toEqual({ title: "T", url: "", content: "" })
	})

	it("passes the abort signal through", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { items: [] } })
		const controller = new AbortController()

		await googleSearch({
			apiKey: "k",
			cseId: "cx",
			query: "q",
			signal: controller.signal,
		})

		const call = vi.mocked(axios.get).mock.calls[0]
		expect(call[1]?.signal).toBe(controller.signal)
	})

	it("propagates axios errors", async () => {
		vi.mocked(axios.get).mockRejectedValue(new Error("HTTP 403"))

		await expect(
			googleSearch({
				apiKey: "k",
				cseId: "cx",
				query: "q",
			}),
		).rejects.toThrow("HTTP 403")
	})
})
