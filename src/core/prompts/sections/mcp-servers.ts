import { McpHub } from "../../../services/mcp/McpHub"
import { buildMcpToolName } from "../../../utils/mcp-name"
import { isServerVisibleToMode } from "../tools/filter-tools-for-mode"

/**
 * Renders the "MCP SERVERS" system-prompt section for the native tool protocol.
 *
 * The native protocol ships MCP tool *schemas* through the API `tools` array
 * (see core/task/build-tools.ts), but an assigned expert mode only reliably
 * *uses* those tools when the system prompt also names the servers and their
 * callable functions. This section therefore injects, on demand, the servers
 * assigned to the current mode — using the same server-side `modes` visibility
 * source of truth as filterMcpToolsForMode — together with their native
 * `mcp--{server}--{tool}` function names, tool descriptions and resources.
 *
 * Returns "" when no server is visible to the mode, so unassigned servers add
 * zero prompt content (on-demand injection, matching the "已分配 MCP" UI).
 *
 * @param mcpHub - The MCP hub instance (undefined => no section).
 * @param modeSlug - The current (execution) mode slug used for visibility filtering.
 * @returns The section text, or "" when nothing is visible to the mode.
 */
export function getMcpServersSection(mcpHub: McpHub | undefined, modeSlug: string): string {
	if (!mcpHub) {
		return ""
	}

	const visibleServers = mcpHub
		.getServers()
		.filter((server) => isServerVisibleToMode(server.name, server.config, modeSlug))

	if (visibleServers.length === 0) {
		return ""
	}

	const serverBlocks = visibleServers
		.map((server) => {
			const tools = server.tools
				?.filter((tool) => tool.enabledForPrompt !== false)
				.map((tool) => `- ${buildMcpToolName(server.name, tool.name)}: ${tool.description ?? "(no description)"}`)
				.join("\n")

			const templates = server.resourceTemplates
				?.map((template) => `- ${template.uriTemplate} (${template.name}): ${template.description ?? ""}`)
				.join("\n")

			const resources = server.resources
				?.map((resource) => `- ${resource.uri} (${resource.name}): ${resource.description ?? ""}`)
				.join("\n")

			return (
				`## ${server.name}` +
				(server.instructions ? `\n\n### Instructions\n${server.instructions}` : "") +
				(tools ? `\n\n### Available Tools\n${tools}` : "") +
				(templates ? `\n\n### Resource Templates\n${templates}` : "") +
				(resources ? `\n\n### Direct Resources\n${resources}` : "")
			)
		})
		.join("\n\n")

	return `====

MCP SERVERS

The following MCP servers are assigned to the current mode. Their tools are already exposed to you as native functions (callable names shown below, format \`mcp--{server}--{tool}\`); call them directly through the native tool-calling mechanism whenever they materially help accomplish the task.

${serverBlocks}`
}
