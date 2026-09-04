import { getMcpServersSection } from "../mcp-servers"
import type { McpHub } from "../../../../services/mcp/McpHub"
import type { McpServer } from "@roo-code/types"

const makeServer = (overrides: Partial<McpServer>): McpServer =>
	({
		name: "srv",
		config: "{}",
		status: "connected",
		...overrides,
	}) as McpServer

const makeHub = (servers: McpServer[]): McpHub =>
	({ getServers: () => servers }) as unknown as McpHub

describe("getMcpServersSection", () => {
	it("returns empty string when mcpHub is undefined", () => {
		expect(getMcpServersSection(undefined, "code")).toBe("")
	})

	it("returns empty string when no servers are connected", () => {
		expect(getMcpServersSection(makeHub([]), "code")).toBe("")
	})

	it("injects a server without a modes field (visible to all modes)", () => {
		const hub = makeHub([
			makeServer({
				name: "playwright",
				tools: [{ name: "browser_navigate", description: "Navigate to a URL" }],
			}),
		])

		const section = getMcpServersSection(hub, "web-researcher")

		expect(section).toContain("MCP SERVERS")
		expect(section).toContain("## playwright")
		expect(section).toContain("mcp--playwright--browser_navigate")
		expect(section).toContain("Navigate to a URL")
	})

	it("excludes a server whose modes field does not include the current mode", () => {
		const hub = makeHub([
			makeServer({ name: "codegraph", config: JSON.stringify({ modes: ["code"] }) }),
		])

		expect(getMcpServersSection(hub, "web-researcher")).toBe("")
	})

	it("includes a server whose modes field includes the current mode", () => {
		const hub = makeHub([
			makeServer({
				name: "playwright",
				config: JSON.stringify({ modes: ["web-researcher"] }),
				tools: [{ name: "browser_navigate", description: "Navigate to a URL" }],
			}),
		])

		const section = getMcpServersSection(hub, "web-researcher")

		expect(section).toContain("## playwright")
		expect(section).toContain("mcp--playwright--browser_navigate")
	})

	it("mixes visible and hidden servers, injecting only the visible one", () => {
		const hub = makeHub([
			makeServer({ name: "codegraph", config: JSON.stringify({ modes: ["code"] }) }),
			makeServer({
				name: "playwright",
				config: JSON.stringify({ modes: ["web-researcher"] }),
				tools: [{ name: "browser_navigate", description: "Navigate to a URL" }],
			}),
		])

		const section = getMcpServersSection(hub, "web-researcher")

		expect(section).toContain("## playwright")
		expect(section).not.toContain("## codegraph")
	})

	it("skips tools with enabledForPrompt === false", () => {
		const hub = makeHub([
			makeServer({
				name: "playwright",
				tools: [
					{ name: "browser_navigate", description: "Navigate to a URL" },
					{ name: "browser_close", description: "Close", enabledForPrompt: false },
				],
			}),
		])

		const section = getMcpServersSection(hub, "web-researcher")

		expect(section).toContain("mcp--playwright--browser_navigate")
		expect(section).not.toContain("mcp--playwright--browser_close")
	})

	it("renders resources and resource templates", () => {
		const hub = makeHub([
			makeServer({
				name: "docs",
				resources: [{ uri: "docs://home", name: "Home", description: "Docs home" }],
				resourceTemplates: [{ uriTemplate: "docs://{page}", name: "Page", description: "A page" }],
			}),
		])

		const section = getMcpServersSection(hub, "code")

		expect(section).toContain("docs://home (Home): Docs home")
		expect(section).toContain("docs://{page} (Page): A page")
	})

	it("renders server instructions when present", () => {
		const hub = makeHub([makeServer({ name: "srv", instructions: "Use carefully." })])

		expect(getMcpServersSection(hub, "code")).toContain("Use carefully.")
	})
})
