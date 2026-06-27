import { describe, it, expect, vi, beforeEach } from "vitest"
import axios from "axios"
import { fetchAndExtract } from "../extract"

vi.mock("axios")

describe("fetchAndExtract", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("extracts the title and cleaned body text, stripping script/style/nav", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: `<!DOCTYPE html>
<html>
<head><title>Godot Docs</title></head>
<body>
  <nav>Home | About | Contact</nav>
  <header>Site header banner</header>
  <script>alert("x")</script>
  <style>body { color: red; }</style>
  <main>
    <h1>Getting Started</h1>
    <p>Godot is a game engine.</p>
    <p>It supports 2D and 3D.</p>
  </main>
  <footer>Copyright 2024</footer>
</body>
</html>`,
		})

		const page = await fetchAndExtract({ url: "https://docs.godotengine.org" })

		expect(page.url).toBe("https://docs.godotengine.org")
		expect(page.title).toBe("Godot Docs")
		expect(page.truncated).toBe(false)
		// Boilerplate removed.
		expect(page.content).not.toContain("alert")
		expect(page.content).not.toContain("color: red")
		expect(page.content).not.toContain("Home | About")
		expect(page.content).not.toContain("Site header banner")
		expect(page.content).not.toContain("Copyright")
		// Main content preserved.
		expect(page.content).toContain("Getting Started")
		expect(page.content).toContain("Godot is a game engine.")
		expect(page.content).toContain("It supports 2D and 3D.")
	})

	it("prefers <main> over <body> when both exist", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: `<html><head><title>T</title></head>
<body>
  <p>body noise that should be ignored</p>
  <main><p>main content only</p></main>
</body></html>`,
		})

		const page = await fetchAndExtract({ url: "https://example.com" })

		expect(page.content).toContain("main content only")
		expect(page.content).not.toContain("body noise")
	})

	it("falls back to <article> when <main> is absent", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: `<html><head><title>T</title></head>
<body>
  <p>body noise</p>
  <article><p>article content</p></article>
</body></html>`,
		})

		const page = await fetchAndExtract({ url: "https://example.com" })

		expect(page.content).toContain("article content")
		expect(page.content).not.toContain("body noise")
	})

	it("falls back to <body> when neither <main> nor <article> exist", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: `<html><head><title>T</title></head>
<body><p>just body content</p></body></html>`,
		})

		const page = await fetchAndExtract({ url: "https://example.com" })

		expect(page.content).toContain("just body content")
	})

	it("truncates content to maxChars and sets truncated=true", async () => {
		const longText = "A".repeat(500)
		vi.mocked(axios.get).mockResolvedValue({
			data: `<html><head><title>Big</title></head><body><main><p>${longText}</p></main></body></html>`,
		})

		const page = await fetchAndExtract({ url: "https://example.com", maxChars: 100 })

		expect(page.truncated).toBe(true)
		expect(page.content.length).toBeLessThanOrEqual(100)
		expect(page.content).toBe("A".repeat(100))
	})

	it("does not truncate when content fits within maxChars", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: `<html><head><title>T</title></head><body><main><p>short</p></main></body></html>`,
		})

		const page = await fetchAndExtract({ url: "https://example.com", maxChars: 12_000 })

		expect(page.truncated).toBe(false)
		expect(page.content).toContain("short")
	})

	it("uses the default maxChars of 12000 when none is provided", async () => {
		const longText = "B".repeat(20_000)
		vi.mocked(axios.get).mockResolvedValue({
			data: `<html><head><title>T</title></head><body><main><p>${longText}</p></main></body></html>`,
		})

		const page = await fetchAndExtract({ url: "https://example.com" })

		expect(page.truncated).toBe(true)
		expect(page.content.length).toBe(12_000)
	})

	it("collapses excessive whitespace in extracted text", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: `<html><head><title>T</title></head>
<body><main>
  <p>  multiple    spaces   and\t\ttabs  </p>
  <p>line1</p>


  <p>line2</p>
</main></body></html>`,
		})

		const page = await fetchAndExtract({ url: "https://example.com" })

		// No runs of multiple spaces/tabs; no runs of 3+ newlines.
		expect(page.content).not.toMatch(/[ \t]{2,}/)
		expect(page.content).not.toMatch(/\n{3,}/)
		expect(page.content).toContain("multiple spaces and tabs")
		expect(page.content).toContain("line1")
		expect(page.content).toContain("line2")
	})

	it("returns empty content when the page has no readable text", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: `<html><head><title>Empty</title></head><body><script>x</script><style>y</style></body></html>`,
		})

		const page = await fetchAndExtract({ url: "https://example.com" })

		expect(page.title).toBe("Empty")
		expect(page.content).toBe("")
		expect(page.truncated).toBe(false)
	})

	it("sends a desktop User-Agent and html Accept header", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: "<html><body><main>x</main></body></html>" })

		await fetchAndExtract({ url: "https://example.com" })

		const config = vi.mocked(axios.get).mock.calls[0][1] as Record<string, unknown>
		const headers = config.headers as Record<string, string>
		expect(headers["User-Agent"]).toMatch(/Mozilla\/5.0/)
		expect(headers["Accept"]).toBe("text/html,application/xhtml+xml")
		expect(config).toMatchObject({
			responseType: "text",
			maxRedirects: 5,
			maxContentLength: 10 * 1024 * 1024,
		})
	})

	it("forwards the AbortSignal to axios", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: "<html><body><main>x</main></body></html>" })
		const controller = new AbortController()

		await fetchAndExtract({ url: "https://example.com", signal: controller.signal })

		const config = vi.mocked(axios.get).mock.calls[0][1] as { signal: AbortSignal }
		expect(config.signal).toBe(controller.signal)
	})

	it("propagates axios errors", async () => {
		vi.mocked(axios.get).mockRejectedValue(new Error("Network error"))

		await expect(fetchAndExtract({ url: "https://example.com" })).rejects.toThrow("Network error")
	})
})
