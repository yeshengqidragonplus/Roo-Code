import type OpenAI from "openai"

const WEB_SEARCH_DESCRIPTION = `Search the web for up-to-date information. Use this when the answer depends on current facts, recent releases, library/API changes, error messages, or anything outside your training knowledge. Returns a ranked list of credible results (title, url, and a cleaned snippet) plus an optional synthesized answer.

This tool only returns short snippets. When you need the full content of a specific result, call web_fetch with that result's url.

For version-specific or authoritative documentation (e.g. game engines, frameworks), scope the search by passing the official documentation domain in allowed_domains so you avoid outdated third-party blog posts.

Parameters:
- query: (required) The search query. Be specific; include version numbers or exact symbol names when relevant.
- max_results: (optional) Maximum number of results to return. Defaults to 5. Pass null to use the default.
- allowed_domains: (optional) Restrict results to these domains, e.g. ["docs.godotengine.org"]. Pass null for an unrestricted web search.`

export default {
	type: "function",
	function: {
		name: "web_search",
		description: WEB_SEARCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The search query",
				},
				max_results: {
					type: ["integer", "null"],
					description: "Maximum number of results to return (default 5)",
				},
				allowed_domains: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Restrict results to these domains; null for unrestricted search",
				},
			},
			required: ["query", "max_results", "allowed_domains"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
