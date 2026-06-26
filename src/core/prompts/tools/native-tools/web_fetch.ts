import type OpenAI from "openai"

const WEB_FETCH_DESCRIPTION = `Fetch a single web page and return its main textual content as cleaned plain text (navigation, scripts, and boilerplate stripped). Use this to read the full content of a URL — typically one returned by web_search, or a documentation page the user pointed you at.

Fetch one focused URL at a time rather than crawling.

When you pass a prompt, a long page is first distilled (by your configured model) down to just the information relevant to that prompt, instead of returning the raw truncated text. Prefer passing a prompt when you only need a specific answer from a large page.

Parameters:
- url: (required) The absolute http(s) URL to fetch.
- prompt: (optional) What you want from the page (e.g. "How do I connect a signal in GDScript?"). Pass null to get the raw cleaned text without distillation.`

export default {
	type: "function",
	function: {
		name: "web_fetch",
		description: WEB_FETCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "The absolute http(s) URL to fetch",
				},
				prompt: {
					type: ["string", "null"],
					description: "What to extract from the page; null to return the raw cleaned text",
				},
			},
			required: ["url", "prompt"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
