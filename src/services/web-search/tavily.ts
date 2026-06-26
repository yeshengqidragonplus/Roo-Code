import axios from "axios"

/**
 * Minimal Tavily Search API client.
 *
 * Tavily is an LLM-oriented search backend: it returns cleaned, relevance-ranked
 * results (and an optional synthesized answer), so the model gets high-signal
 * content without us scraping search-engine HTML ourselves.
 *
 * Docs: https://docs.tavily.com/
 */

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search"

export interface TavilySearchResult {
	title: string
	url: string
	/** Cleaned, relevance-ranked snippet of the page content. */
	content: string
	score?: number
}

export interface TavilySearchResponse {
	/** Optional LLM-synthesized answer to the query (when includeAnswer is set). */
	answer?: string
	results: TavilySearchResult[]
}

export interface TavilySearchOptions {
	apiKey: string
	query: string
	/** Max number of results to return (Tavily caps this; we default to 5). */
	maxResults?: number
	/** Restrict results to these domains (e.g. ["docs.godotengine.org"]). */
	includeDomains?: string[]
	/** "basic" is fast/cheap; "advanced" is higher quality. */
	searchDepth?: "basic" | "advanced"
	/** Ask Tavily for a synthesized answer in addition to raw results. */
	includeAnswer?: boolean
	signal?: AbortSignal
}

export async function tavilySearch(options: TavilySearchOptions): Promise<TavilySearchResponse> {
	const {
		apiKey,
		query,
		maxResults = 5,
		includeDomains,
		searchDepth = "basic",
		includeAnswer = true,
		signal,
	} = options

	const { data } = await axios.post(
		TAVILY_SEARCH_ENDPOINT,
		{
			query,
			max_results: maxResults,
			search_depth: searchDepth,
			include_answer: includeAnswer,
			...(includeDomains && includeDomains.length > 0 ? { include_domains: includeDomains } : {}),
		},
		{
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			timeout: 30_000,
			signal,
		},
	)

	const results: TavilySearchResult[] = Array.isArray(data?.results)
		? data.results.map((r: any) => ({
				title: String(r?.title ?? ""),
				url: String(r?.url ?? ""),
				content: String(r?.content ?? ""),
				score: typeof r?.score === "number" ? r.score : undefined,
			}))
		: []

	return {
		answer: typeof data?.answer === "string" ? data.answer : undefined,
		results,
	}
}
