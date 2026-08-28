import axios from "axios"
import * as cheerio from "cheerio"

/**
 * Free Bing web search backend (no API key required).
 *
 * Queries Bing's public HTML search page and parses the organic results out of
 * the markup, so regular web searches cost nothing (no Tavily / Google CSE
 * quota). This is the same "scrape the search engine's HTML page" approach the
 * `ddgs` Python library uses; Bing was chosen over DuckDuckGo because its HTML
 * endpoint is far less aggressive with bot challenges (DuckDuckGo serves a
 * 202 "select all squares containing a duck" captcha to plain HTTP clients).
 *
 * Bing result links are wrapped in click-through redirects
 * (`/ck/a?...&u=a1<base64url>`), so we decode the `u` parameter to recover the
 * real target URL.
 */

const BING_SEARCH_ENDPOINT = "https://www.bing.com/search"

export interface BingSearchResult {
	title: string
	url: string
	/** Snippet text extracted from the result markup. */
	content: string
}

export interface BingSearchResponse {
	results: BingSearchResult[]
}

export interface BingSearchOptions {
	query: string
	/** Max number of results to return (default 5). */
	maxResults?: number
	/**
	 * Restrict results to these domains (e.g. ["docs.unity3d.com"]).
	 * Implemented via Bing's `site:` operator (OR-joined).
	 */
	includeDomains?: string[]
	signal?: AbortSignal
}

/**
 * Decode Bing click-through links: `/ck/a?...&u=a1<base64url-encoded-url>`.
 * The `u` parameter starts with `a1` followed by a base64url payload.
 */
export function unwrapBingUrl(href: string): string {
	try {
		const url = new URL(href, "https://www.bing.com")
		const u = url.searchParams.get("u")
		if (u && u.startsWith("a1")) {
			const encoded = u.slice(2).replace(/-/g, "+").replace(/_/g, "/")
			const decoded = Buffer.from(encoded, "base64").toString("utf-8")
			if (/^https?:\/\//i.test(decoded)) {
				return decoded
			}
		}
		return href
	} catch {
		return href
	}
}

/** Parse the Bing results page (`li.b_algo` blocks with `h2 > a` + `.b_caption p`). */
function parseBingHtml(html: string): BingSearchResult[] {
	const $ = cheerio.load(html)
	const results: BingSearchResult[] = []

	$("li.b_algo").each((_, el) => {
		const link = $(el).find("h2 a").first()
		const href = link.attr("href") ?? ""
		const title = link.text().replace(/\s+/g, " ").trim()
		// Snippet: prefer the caption paragraph, fall back to any paragraph.
		const snippet =
			$(el).find(".b_caption p").first().text() || $(el).find("p").first().text()
		const content = snippet.replace(/\s+/g, " ").trim()
		if (href && title) {
			results.push({ title, url: unwrapBingUrl(href), content })
		}
	})

	return results
}

export async function bingSearch(options: BingSearchOptions): Promise<BingSearchResponse> {
	const { query, maxResults = 5, includeDomains, signal } = options

	// Domain restriction via the `site:` operator (OR-joined).
	let effectiveQuery = query
	if (includeDomains && includeDomains.length > 0) {
		const siteFilters = includeDomains.map((d) => `site:${d}`).join(" OR ")
		effectiveQuery = `${query} (${siteFilters})`
	}

	const headers = {
		// A browser-like UA keeps Bing from serving simplified/bot pages.
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
		"Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	}

	// Request enough results to survive de-duplication, capped at Bing's page size.
	const resp = await axios.get<string>(BING_SEARCH_ENDPOINT, {
		params: { q: effectiveQuery, count: String(Math.min(Math.max(maxResults, 5), 20)) },
		headers,
		timeout: 30_000,
		signal,
		responseType: "text",
	})

	const parsed = parseBingHtml(resp.data)

	// De-duplicate by URL and cap at maxResults.
	const seen = new Set<string>()
	const results: BingSearchResult[] = []
	for (const r of parsed) {
		if (!r.url || seen.has(r.url)) {
			continue
		}
		seen.add(r.url)
		results.push(r)
		if (results.length >= maxResults) {
			break
		}
	}

	return { results }
}
