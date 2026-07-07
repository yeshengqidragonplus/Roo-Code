// npx vitest run core/task/__tests__/build-tools.spec.ts

import type { ClineProvider } from "../../webview/ClineProvider"
import type { McpHub } from "../../../services/mcp/McpHub"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => undefined,
	},
}))

function makeMcpHub(servers: Array<{ name: string; modes?: string[]; toolNames: string[] }>): McpHub {
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
				tools: server.toolNames.map((name) => ({
					name,
					description: `${name} tool`,
					inputSchema: { type: "object", properties: {} },
				})),
			})),
	} as unknown as McpHub
}

function makeProvider(mcpHub: McpHub): ClineProvider {
	return {
		getMcpHub: () => mcpHub,
		context: {},
	} as unknown as ClineProvider
}

function getToolNames(tools: Array<{ function?: { name: string } }>): string[] {
	return tools.map((tool) => tool.function!.name)
}

describe("buildNativeToolsArrayWithRestrictions - per-server mode visibility", () => {
	const mcpHub = makeMcpHub([
		{ name: "unity-pro", modes: ["unity-context"], toolNames: ["outline", "resolve"] },
		{ name: "docs-server", toolNames: ["search"] },
	])

	it("excludes hidden server tools from the default filtered tools array", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider(mcpHub),
			cwd: "/test",
			mode: "code",
			customModes: undefined,
			experiments: undefined,
			apiConfiguration: undefined,
		})

		const names = getToolNames(result.tools as any)
		expect(names).not.toContain("mcp--unity-pro--outline")
		expect(names).not.toContain("mcp--unity-pro--resolve")
		expect(names).toContain("mcp--docs-server--search")
		expect(result.allowedFunctionNames).toBeUndefined()
	})

	it("keeps hidden server tools in allTools but out of allowedFunctionNames (Gemini path)", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider(mcpHub),
			cwd: "/test",
			mode: "code",
			customModes: undefined,
			experiments: undefined,
			apiConfiguration: undefined,
			includeAllToolsWithRestrictions: true,
		})

		// allTools keeps every definition so historical tool calls stay referenceable
		const allNames = getToolNames(result.tools as any)
		expect(allNames).toContain("mcp--unity-pro--outline")
		expect(allNames).toContain("mcp--docs-server--search")

		// but the callable set excludes the hidden server
		expect(result.allowedFunctionNames).not.toContain("mcp--unity-pro--outline")
		expect(result.allowedFunctionNames).not.toContain("mcp--unity-pro--resolve")
		expect(result.allowedFunctionNames).toContain("mcp--docs-server--search")
	})

	it("includes all server tools for a whitelisted mode", async () => {
		const customModes = [
			{
				slug: "unity-context",
				name: "Unity Context",
				roleDefinition: "test",
				groups: ["read", "mcp"],
			},
		] as any

		const result = await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider(mcpHub),
			cwd: "/test",
			mode: "unity-context",
			customModes,
			experiments: undefined,
			apiConfiguration: undefined,
		})

		const names = getToolNames(result.tools as any)
		expect(names).toContain("mcp--unity-pro--outline")
		expect(names).toContain("mcp--unity-pro--resolve")
		expect(names).toContain("mcp--docs-server--search")
	})
})
