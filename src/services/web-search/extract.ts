import axios from "axios"
import * as cheerio from "cheerio"

/**
 * Fetches a URL locally (from the user's machine) and extracts the main textual
 * content as cleaned plain text.
 *
 * This mirrors the "fetch locally, then strip boilerplate" half of the two-stage
 * web pipeline: search returns links, fetch returns readable content. The cheerio
 * pass removes nav/script/style/footer noise so the model sees signal, not chrome.
 *
 * NOTE (Phase 1): we stop at cleaned + truncated text. A follow-up can add a
 * small-model compression step (à la Claude Code's WebFetch + Haiku) that distills
 * the extracted text against the caller's question before returning.
 */

const DEFAULT_MAX_CHARS = 12_000
const FETCH_TIMEOUT_MS = 30_000
// Avoid pulling multi-MB assets into memory; web pages we care about are well under this.
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

export interface FetchedPage {
	url: string
	title: string
	/** Cleaned plain-text content, truncated to maxChars. */
	content: string
	/** True when the content was truncated to fit maxChars. */
	truncated: boolean
}

export interface FetchPageOptions {
	url: string
	maxChars?: number
	signal?: AbortSignal
}

export async function fetchAndExtract(options: FetchPageOptions): Promise<FetchedPage> {
	const { url, maxChars = DEFAULT_MAX_CHARS, signal } = options

	const { data: html } = await axios.get<string>(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
		timeout: FETCH_TIMEOUT_MS,
		maxContentLength: MAX_CONTENT_LENGTH,
		maxRedirects: 5,
		responseType: "text",
		signal,
	})

	const $ = cheerio.load(html)

	// Drop non-content nodes before extracting text.
	$("script, style, noscript, nav, header, footer, aside, form, svg, iframe").remove()

	const title = $("title").first().text().trim()

	// Prefer the semantic main/article region when present; fall back to body.
	const root = $("main").first().length
		? $("main").first()
		: $("article").first().length
			? $("article").first()
			: $("body")

	const rawText = root.text()
	const cleaned = rawText
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()

	const truncated = cleaned.length > maxChars
	const content = truncated ? cleaned.slice(0, maxChars) : cleaned

	return { url, title, content, truncated }
}
