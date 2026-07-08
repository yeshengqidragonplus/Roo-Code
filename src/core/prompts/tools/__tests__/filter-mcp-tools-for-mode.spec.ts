// npx vitest run core/prompts/tools/__tests__/filter-mcp-tools-for-mode.spec.ts

import type OpenAI from "openai"

import type { McpServer, ModeConfig } from "@roo-code/types"
import type { McpHub } from "../../../../services/mcp/McpHub"

import { filterMcpToolsForMode, isServerVisibleToMode } from "../filter-tools-for-mode"

/**
 * Custom mode that owns a restricted MCP server.
 */
const unityContextMode: ModeConfig = {
	slug: "unity-context",
	name: "🎮 Unity Context",
	roleDefinition: "Unity expert.",
	groups: ["read", "mcp"],
}

/**
 * Custom mode without an mcp group (read-only, no MCP).
 */
const noMcpMode: ModeConfig = {
	slug: "no-mcp-mode",
	name: "No MCP Mode",
	roleDefinition: "Read only, no MCP.",
	groups: ["read"],
}

/**
 * Builds an OpenAI function-tool definition with the given name.
 */
function makeTool(name: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name,
			description: `${name} tool`,
			parameters: { type: "object", properties: {} },
		},
	} as OpenAI.Chat.ChatCompletionTool
}

/**
 * Creates a minimal McpServer-shaped object for tests. The `config` field is a
 * JSON string (matching McpHub's storage convention); it may carry a `modes`
 * array to restrict server visibility to specific modes.
 */
function makeServer(name: string, modes?: string[]): McpServer {
	const config: Record<string, unknown> = { type: "stdio", command: "test" }
	if (modes) {
		config.modes = modes
	}
	return {
		name,
		config: JSON.stringify(config),
		status: "connected",
		source: "global",
	}
}

/**
 * Creates a fake McpHub whose getServers() returns the provided servers.
 */
function makeMcpHub(servers: McpServer[]): Partial<McpHub> {
	return {
		getServers: vi.fn().mockReturnValue(servers),
	}
}

// ---------------------------------------------------------------------------
// isServerVisibleToMode
// ---------------------------------------------------------------------------

describe("isServerVisibleToMode", () => {
	it("returns true (visible to all) when config has no modes field", () => {
		const server = makeServer("srv")
		expect(isServerVisibleToMode("srv", server.config, "code")).toBe(true)
		expect(isServerVisibleToMode("srv", server.config, "unity-context")).toBe(true)
	})

	it("returns true only when the mode is listed in modes", () => {
		const server = makeServer("srv", ["unity-context"])
		expect(isServerVisibleToMode("srv", server.config, "unity-context")).toBe(true)
		expect(isServerVisibleToMode("srv", server.config, "code")).toBe(false)
	})

	it("returns true (visible to all) when config is undefined", () => {
		expect(isServerVisibleToMode("srv", undefined, "code")).toBe(true)
	})

	it("returns true (visible to all) when config JSON is invalid", () => {
		expect(isServerVisibleToMode("srv", "{invalid json", "code")).toBe(true)
	})

	it("returns true (visible to all) when modes is an empty array", () => {
		const server: McpServer = {
			name: "srv",
			config: JSON.stringify({ type: "stdio", command: "test", modes: [] }),
			status: "connected",
		}
		expect(isServerVisibleToMode("srv", server.config, "code")).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// filterMcpToolsForMode - zero-impact (isolation principle)
// ---------------------------------------------------------------------------

describe("filterMcpToolsForMode - zero-impact", () => {
	const mcpTools = [makeTool("mcp--serverA--tool1"), makeTool("mcp--serverA--tool2"), makeTool("mcp--serverB--tool1")]

	it("returns empty when mode has no mcp group (no mcpHub)", () => {
		// "orchestrator" built-in mode has an empty groups array (no mcp group)
		const result = filterMcpToolsForMode(mcpTools, "orchestrator", undefined, undefined)
		expect(result).toEqual([])
	})

	it("returns empty when a custom mode has no mcp group (no mcpHub)", () => {
		const result = filterMcpToolsForMode(mcpTools, "no-mcp-mode", [noMcpMode], undefined)
		expect(result).toEqual([])
	})

	it("returns all tools when mode has mcp group and no mcpHub is provided", () => {
		const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined)
		expect(result.map((t) => (t as any).function.name)).toEqual([
			"mcp--serverA--tool1",
			"mcp--serverA--tool2",
			"mcp--serverB--tool1",
		])
	})

	it("returns all tools when servers have no modes field (mcpHub provided)", () => {
		const hub = makeMcpHub([makeServer("serverA"), makeServer("serverB")])
		const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, hub as McpHub)
		expect(result.map((t) => (t as any).function.name)).toEqual([
			"mcp--serverA--tool1",
			"mcp--serverA--tool2",
			"mcp--serverB--tool1",
		])
	})

	it("output is byte-for-byte identical with/without mcpHub when no modes set", () => {
		const hub = makeMcpHub([makeServer("serverA"), makeServer("serverB")])
		const withoutHub = filterMcpToolsForMode(mcpTools, "code", undefined, undefined)
		const withHub = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, hub as McpHub)
		expect(withHub).toEqual(withoutHub)
	})
})

// ---------------------------------------------------------------------------
// filterMcpToolsForMode - visibility filtering
// ---------------------------------------------------------------------------

describe("filterMcpToolsForMode - filtering", () => {
	it("filters out a server whose modes excludes the current mode", () => {
		const hub = makeMcpHub([makeServer("serverA", ["unity-context"]), makeServer("serverB")])
		const mcpTools = [
			makeTool("mcp--serverA--tool1"),
			makeTool("mcp--serverA--tool2"),
			makeTool("mcp--serverB--tool1"),
		]

		const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, hub as McpHub)

		const names = result.map((t) => (t as any).function.name)
		expect(names).not.toContain("mcp--serverA--tool1")
		expect(names).not.toContain("mcp--serverA--tool2")
		expect(names).toContain("mcp--serverB--tool1")
	})

	it("keeps a server whose modes includes the current mode", () => {
		const hub = makeMcpHub([makeServer("serverA", ["unity-context"])])
		const mcpTools = [makeTool("mcp--serverA--tool1")]

		const result = filterMcpToolsForMode(mcpTools, "unity-context", [unityContextMode], undefined, hub as McpHub)

		expect(result.map((t) => (t as any).function.name)).toContain("mcp--serverA--tool1")
	})

	it("handles mixed servers: restricted filtered, unrestricted kept", () => {
		const hub = makeMcpHub([
			makeServer("unity-pro", ["unity-context"]),
			makeServer("public-server"),
			makeServer("restricted", ["architect"]),
		])
		const mcpTools = [
			makeTool("mcp--unity-pro--outline"),
			makeTool("mcp--public-server--search"),
			makeTool("mcp--restricted--build"),
		]

		const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, hub as McpHub)
		const names = result.map((t) => (t as any).function.name)

		expect(names).not.toContain("mcp--unity-pro--outline")
		expect(names).not.toContain("mcp--restricted--build")
		expect(names).toContain("mcp--public-server--search")
	})

	it("matches truncated tool names by prefix (prefix always intact)", () => {
		// buildMcpToolName truncates to 64 chars; the tool segment gets cut but
		// the mcp--server-- prefix is always complete.
		const longToolName = "a".repeat(80)
		const hub = makeMcpHub([makeServer("serverA", ["unity-context"])])
		const truncatedName = `mcp--serverA--${longToolName}`.slice(0, 64)
		const mcpTools = [makeTool(truncatedName), makeTool("mcp--serverB--tool")]

		// Add serverB to hub so it isn't accidentally filtered
		hub.getServers = vi.fn().mockReturnValue([makeServer("serverA", ["unity-context"]), makeServer("serverB")])

		const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, hub as McpHub)
		const names = result.map((t) => (t as any).function.name)

		expect(names).not.toContain(truncatedName)
		expect(names).toContain("mcp--serverB--tool")
	})

	it("handles server names with special characters (sanitized prefix)", () => {
		// sanitizeMcpName("my server") => "my_server"
		const hub = makeMcpHub([makeServer("my server", ["unity-context"])])
		const mcpTools = [makeTool("mcp--my_server--tool1"), makeTool("mcp--other--tool2")]

		const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, hub as McpHub)
		const names = result.map((t) => (t as any).function.name)

		expect(names).not.toContain("mcp--my_server--tool1")
		expect(names).toContain("mcp--other--tool2")
	})

	it("does not filter when mcpHub is provided but mode has no mcp group", () => {
		const hub = makeMcpHub([makeServer("serverA", ["unity-context"])])
		const mcpTools = [makeTool("mcp--serverA--tool1")]

		// "ask" mode has no mcp group => empty result regardless
		const result = filterMcpToolsForMode(mcpTools, "ask", undefined, undefined, hub as McpHub)
		expect(result).toEqual([])
	})
})
