import { describe, it, expect, vi, beforeEach } from "vitest"
import axios from "axios"
import { bingSearch, unwrapBingUrl } from "../bing"

vi.mock("axios")

// Base64url of "https://unity.com/docs" prefixed with "a1".
const REDIRECT_U = "a1" + Buffer.from("https://unity.com/docs").toString("base64url")

const BING_HTML_RESPONSE = `
<html><body>
<li class="b_algo">
  <h2><a href="https://www.bing.com/ck/a?!&&p=xyz&u=${REDIRECT_U}&ntb=1">Unity Docs</a></h2>
  <div class="b_caption"><p>Unity is a <strong>game engine</strong>.</p></div>
</li>
<li class="b_algo">
  <h2><a href="https://unrealengine.com">Unreal Engine</a></h2>
  <p>Unreal is powerful.</p>
</li>
<li class="b_algo">
  <h2><a href="https://www.bing.com/ck/a?!&&p=xyz&u=${REDIRECT_U}&ntb=1">Duplicate</a></h2>
  <p>dup</p>
</li>
</body></html>
`

describe("unwrapBingUrl", () => {
	it("decodes base64url click-through links", () => {
		expect(unwrapBingUrl(`https://www.bing.com/ck/a?u=${REDIRECT_U}`)).toBe("https://unity.com/docs")
	})

	it("returns plain links unchanged", () => {
		expect(unwrapBingUrl("https://example.com")).toBe("https://example.com")
	})

	it("returns the input on malformed URLs", () => {
		expect(unwrapBingUrl("::::not-a-url")).toBe("::::not-a-url")
	})
})

describe("bingSearch", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("parses organic results, unwraps redirects and de-duplicates", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: BING_HTML_RESPONSE })

		const { results } = await bingSearch({ query: "game engines" })

		expect(axios.get).toHaveBeenCalledTimes(1)
		expect(results).toHaveLength(2)
		expect(results[0]).toEqual({
			title: "Unity Docs",
			url: "https://unity.com/docs",
			content: "Unity is a game engine.",
		})
		expect(results[1].url).toBe("https://unrealengine.com")
	})

	it("caps results at maxResults", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: BING_HTML_RESPONSE })

		const { results } = await bingSearch({ query: "q", maxResults: 1 })

		expect(results).toHaveLength(1)
	})

	it("appends site: filters for includeDomains", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: BING_HTML_RESPONSE })

		await bingSearch({ query: "physics", includeDomains: ["docs.unity3d.com", "docs.unrealengine.com"] })

		const call = vi.mocked(axios.get).mock.calls[0]
		expect(call[1]?.params?.q).toBe("physics (site:docs.unity3d.com OR site:docs.unrealengine.com)")
	})

	it("propagates request errors", async () => {
		vi.mocked(axios.get).mockRejectedValue(new Error("network down"))

		await expect(bingSearch({ query: "q" })).rejects.toThrow("network down")
	})

	it("passes the abort signal through", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: BING_HTML_RESPONSE })
		const controller = new AbortController()

		await bingSearch({ query: "q", signal: controller.signal })

		expect(vi.mocked(axios.get).mock.calls[0][1]?.signal).toBe(controller.signal)
	})
})
