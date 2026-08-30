// npx vitest run core/prompts/tools/__tests__/filter-tools-for-mode.spec.ts

import type OpenAI from "openai"

import type { McpHub } from "../../../../services/mcp/McpHub"
import { filterMcpToolsForMode, filterNativeToolsForMode } from "../filter-tools-for-mode"

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

describe("filterNativeToolsForMode - disabledTools", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("execute_command"),
		makeTool("read_file"),
		makeTool("write_to_file"),
		makeTool("apply_diff"),
		makeTool("edit"),
	]

	it("removes tools listed in settings.disabledTools", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is empty", () => {
		const settings = {
			disabledTools: [],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is undefined", () => {
		const settings = {}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
	})

	it("combines disabledTools with other setting-based exclusions", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("execute_command")
		expect(resultNames).toContain("read_file")
	})

	it("disables canonical tool when disabledTools contains alias name", () => {
		const settings = {
			disabledTools: ["search_and_replace"],
			modelInfo: {
				includedTools: ["search_and_replace"],
			},
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("search_and_replace")
		expect(resultNames).not.toContain("edit")
	})
})

describe("filterNativeToolsForMode - exact Mode tool selection", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("read_file"),
		makeTool("search_files"),
		makeTool("write_to_file"),
		makeTool("execute_command"),
		makeTool("attempt_completion"),
	]

	it("only injects explicitly selected native tools while retaining required lifecycle tools", () => {
		const customModes = [
			{
				slug: "precise-mode",
				name: "Precise Mode",
				roleDefinition: "test",
				groups: ["read", "edit", "command"],
				nativeToolNames: ["read_file"],
			},
		] as any

		const result = filterNativeToolsForMode(nativeTools, "precise-mode", customModes, undefined)
		expect(result.map((tool) => (tool as any).function.name)).toEqual(["read_file", "attempt_completion"])
	})
})

describe("filterMcpToolsForMode - per-server mode visibility", () => {
	function makeMcpHub(servers: Array<{ name: string; modes?: string[] }>): McpHub {
		return {
			getServers: () =>
				servers.map((server) => ({
					name: server.name,
					config: JSON.stringify(
						server.modes
							? { type: "stdio", command: "test", modes: server.modes }
							: { type: "stdio", command: "test" },
					),
					status: "connected",
				})),
		} as unknown as McpHub
	}

	const mcpTools = [
		makeTool("mcp--unity-pro--outline"),
		makeTool("mcp--unity-pro--resolve"),
		makeTool("mcp--docs-server--search"),
	]

	describe("zero-impact when no server restricts modes", () => {
		it("returns the exact same tools when no mcpHub is provided", () => {
			const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined)
			expect(result).toBe(mcpTools)
		})

		it("returns the exact same tools when no server has a modes whitelist", () => {
			const mcpHub = makeMcpHub([{ name: "unity-pro" }, { name: "docs-server" }])
			const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, mcpHub)
			expect(result).toBe(mcpTools)
		})

		it("still returns empty array when the mode has no mcp group", () => {
			const mcpHub = makeMcpHub([{ name: "unity-pro" }])
			const customModes = [
				{
					slug: "no-mcp-mode",
					name: "No MCP",
					roleDefinition: "test",
					groups: ["read"],
				},
			] as any
			const result = filterMcpToolsForMode(mcpTools, "no-mcp-mode", customModes, undefined, mcpHub)
			expect(result).toEqual([])
		})
	})

	describe("filtering by server modes whitelist", () => {
		it("hides a restricted server's tools from modes not in its whitelist", () => {
			const mcpHub = makeMcpHub([{ name: "unity-pro", modes: ["unity-context"] }, { name: "docs-server" }])
			const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, mcpHub)
			const names = result.map((t) => (t as any).function.name)
			expect(names).toEqual(["mcp--docs-server--search"])
		})

		it("shows a restricted server's tools to a mode in its whitelist", () => {
			const mcpHub = makeMcpHub([{ name: "unity-pro", modes: ["unity-context"] }, { name: "docs-server" }])
			const customModes = [
				{
					slug: "unity-context",
					name: "Unity Context",
					roleDefinition: "test",
					groups: ["read", "mcp"],
				},
			] as any
			const result = filterMcpToolsForMode(mcpTools, "unity-context", customModes, undefined, mcpHub)
			const names = result.map((t) => (t as any).function.name)
			expect(names).toEqual(["mcp--unity-pro--outline", "mcp--unity-pro--resolve", "mcp--docs-server--search"])
		})

		it("filters multiple restricted servers independently", () => {
			const mcpHub = makeMcpHub([
				{ name: "unity-pro", modes: ["unity-context"] },
				{ name: "docs-server", modes: ["ask"] },
			])
			const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, mcpHub)
			expect(result).toEqual([])
		})

		it("matches truncated tool names by server prefix", () => {
			// buildMcpToolName caps at 64 chars; only the tool segment is ever cut,
			// so the mcp--{server}-- prefix stays intact.
			const longToolName = ("mcp--unity-pro--" + "a".repeat(80)).slice(0, 64)
			const mcpHub = makeMcpHub([{ name: "unity-pro", modes: ["unity-context"] }])
			const result = filterMcpToolsForMode([makeTool(longToolName)], "code", undefined, undefined, mcpHub)
			expect(result).toEqual([])
		})

		it("matches servers whose names require sanitization", () => {
			// "my unity server" sanitizes to "my_unity_server" in tool names
			const mcpHub = makeMcpHub([{ name: "my unity server", modes: ["unity-context"] }])
			const tools = [makeTool("mcp--my_unity_server--outline"), makeTool("mcp--docs-server--search")]
			const result = filterMcpToolsForMode(tools, "code", undefined, undefined, mcpHub)
			const names = result.map((t) => (t as any).function.name)
			expect(names).toEqual(["mcp--docs-server--search"])
		})

		it("does not hide tools of a different server sharing a name prefix", () => {
			const mcpHub = makeMcpHub([{ name: "unity", modes: ["unity-context"] }, { name: "unity-pro" }])
			const tools = [makeTool("mcp--unity--outline"), makeTool("mcp--unity-pro--outline")]
			const result = filterMcpToolsForMode(tools, "code", undefined, undefined, mcpHub)
			const names = result.map((t) => (t as any).function.name)
			expect(names).toEqual(["mcp--unity-pro--outline"])
		})

		it("treats malformed server config JSON as unrestricted", () => {
			const mcpHub = {
				getServers: () => [{ name: "unity-pro", config: "not json", status: "connected" }],
			} as unknown as McpHub
			const result = filterMcpToolsForMode(mcpTools, "code", undefined, undefined, mcpHub)
			expect(result).toBe(mcpTools)
		})
	})
})
