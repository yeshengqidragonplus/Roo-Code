import axios from "axios"

/**
 * Google Custom Search (Programmable Search Engine) API client.
 *
 * Uses the official JSON API (https://www.googleapis.com/customsearch/v1),
 * which requires a Google Cloud API key and a Custom Search Engine ID (cx).
 * Free tier: 100 queries/day; $5 per 1,000 queries beyond that.
 *
 * Returns the same shape as TavilySearchResult (title/url/content) so the
 * WebSearchTool can treat both backends uniformly.
 *
 * Docs: https://developers.google.com/custom-search/v1/overview
 */

const GOOGLE_CSE_ENDPOINT = "https://www.googleapis.com/customsearch/v1"

export interface GoogleSearchResult {
	title: string
	url: string
	/** Snippet text from the search result (Google's "snippet" field). */
	content: string
}

export interface GoogleSearchResponse {
	results: GoogleSearchResult[]
}

export interface GoogleSearchOptions {
	apiKey: string
	/** Custom Search Engine ID (the "cx" parameter). */
	cseId: string
	query: string
	/** Max number of results (Google caps at 10 per request; default 5). */
	maxResults?: number
	/** Restrict results to these domains (mapped to Google's site filter). */
	includeDomains?: string[]
	signal?: AbortSignal
}

export async function googleSearch(options: GoogleSearchOptions): Promise<GoogleSearchResponse> {
	const { apiKey, cseId, query, maxResults = 5, includeDomains, signal } = options

	// Google CSE supports restricting to specific sites via the "hq" param
	// (append "site:example.com" terms). We join multiple domains with " OR ".
	const siteFilter =
		includeDomains && includeDomains.length > 0
			? includeDomains.map((d) => `site:${d}`).join(" OR ")
			: undefined

	const params: Record<string, string> = {
		key: apiKey,
		cx: cseId,
		q: query,
		num: String(Math.min(maxResults, 10)),
	}
	if (siteFilter) {
		params.hq = siteFilter
	}

	const { data } = await axios.get(GOOGLE_CSE_ENDPOINT, {
		params,
		timeout: 30_000,
		signal,
	})

	const items = Array.isArray(data?.items) ? data.items : []

	const results: GoogleSearchResult[] = items.map((item: any) => ({
		title: String(item?.title ?? ""),
		url: String(item?.link ?? ""),
		// Google returns HTML in snippets; strip tags for a clean text preview.
		content: String(item?.snippet ?? "").replace(/<[^>]*>/g, ""),
	}))

	return { results }
}
