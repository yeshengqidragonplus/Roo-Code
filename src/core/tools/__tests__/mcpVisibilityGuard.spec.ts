// npx vitest run core/tools/__tests__/mcpVisibilityGuard.spec.ts

import type { Task } from "../../task/Task"
import { ensureServerVisibleToMode } from "../mcpVisibilityGuard"
import { useMcpToolTool } from "../UseMcpToolTool"
import { accessMcpResourceTool } from "../accessMcpResourceTool"

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((result: string) => `Tool result: ${result}`),
		toolError: vi.fn((error: string) => `Tool error: ${error}`),
		toolDenied: vi.fn(() => "Tool denied"),
		mcpServerNotVisibleToMode: vi.fn(
			(server: string, mode: string) => `Server '${server}' is not visible to mode '${mode}'`,
		),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, params?: Record<string, string>) => `${key}|${params?.serverName}|${params?.mode}`),
}))

interface MockServerSpec {
	name: string
	modes?: string[]
	toolNames?: string[]
}

function makeServers(specs: MockServerSpec[]) {
	return specs.map((spec) => ({
		name: spec.name,
		config: JSON.stringify(
			spec.modes ? { type: "stdio", command: "test", modes: spec.modes } : { type: "stdio", command: "test" },
		),
		status: "connected",
		tools: (spec.toolNames ?? []).map((name) => ({ name, description: `${name} tool` })),
	}))
}

function makeTask(options: {
	servers?: ReturnType<typeof makeServers>
	mode?: string | undefined
	hubOverrides?: Record<string, unknown>
}) {
	const servers = options.servers ?? []
	const mcpHub = {
		getServers: vi.fn().mockReturnValue(servers),
		getAllServers: vi.fn().mockReturnValue(servers),
		callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
		readResource: vi.fn().mockResolvedValue({ contents: [] }),
		...options.hubOverrides,
	}

	const provider = {
		getMcpHub: vi.fn().mockReturnValue(mcpHub),
		getState: vi.fn().mockResolvedValue(options.mode === undefined ? undefined : { mode: options.mode }),
		postMessageToWebview: vi.fn(),
	}

	const task = {
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		recordToolUsage: vi.fn(),
		sayAndCreateMissingParamError: vi.fn(),
		say: vi.fn(),
		ask: vi.fn(),
		lastMessageTs: 123456789,
		providerRef: { deref: vi.fn().mockReturnValue(provider) },
	}

	return { task: task as unknown as Task, mcpHub, provider, taskMock: task }
}

describe("ensureServerVisibleToMode", () => {
	let pushToolResult: ReturnType<typeof vi.fn>

	beforeEach(() => {
		pushToolResult = vi.fn()
	})

	it("allows servers without a modes whitelist", async () => {
		const { task } = makeTask({ servers: makeServers([{ name: "docs-server" }]), mode: "code" })

		const result = await ensureServerVisibleToMode(task, "use_mcp_tool", "docs-server", pushToolResult)

		expect(result).toBe(true)
		expect(pushToolResult).not.toHaveBeenCalled()
	})

	it("allows a whitelisted mode", async () => {
		const { task } = makeTask({
			servers: makeServers([{ name: "unity-pro", modes: ["unity-context"] }]),
			mode: "unity-context",
		})

		const result = await ensureServerVisibleToMode(task, "use_mcp_tool", "unity-pro", pushToolResult)

		expect(result).toBe(true)
		expect(pushToolResult).not.toHaveBeenCalled()
	})

	it("blocks a mode outside the whitelist and pushes a delegation-hint error", async () => {
		const { task, taskMock } = makeTask({
			servers: makeServers([{ name: "unity-pro", modes: ["unity-context"] }]),
			mode: "code",
		})

		const result = await ensureServerVisibleToMode(task, "use_mcp_tool", "unity-pro", pushToolResult)

		expect(result).toBe(false)
		expect(taskMock.consecutiveMistakeCount).toBe(1)
		expect(taskMock.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
		expect(taskMock.didToolFailInCurrentTurn).toBe(true)
		expect(taskMock.say).toHaveBeenCalledWith("error", "mcp:errors.serverNotVisibleToMode|unity-pro|code")
		expect(pushToolResult).toHaveBeenCalledWith("Tool error: Server 'unity-pro' is not visible to mode 'code'")
	})

	it("records the calling tool name on failure", async () => {
		const { task, taskMock } = makeTask({
			servers: makeServers([{ name: "unity-pro", modes: ["unity-context"] }]),
			mode: "code",
		})

		await ensureServerVisibleToMode(task, "access_mcp_resource", "unity-pro", pushToolResult)

		expect(taskMock.recordToolError).toHaveBeenCalledWith("access_mcp_resource")
	})

	it("falls back to the default mode slug when state is unavailable", async () => {
		const { task } = makeTask({
			servers: makeServers([{ name: "unity-pro", modes: ["unity-context"] }]),
			mode: undefined,
		})

		const result = await ensureServerVisibleToMode(task, "use_mcp_tool", "unity-pro", pushToolResult)

		expect(result).toBe(false)
	})

	it("allows unknown servers (existence validation owns that case)", async () => {
		const { task } = makeTask({ servers: makeServers([{ name: "other" }]), mode: "code" })

		const result = await ensureServerVisibleToMode(task, "use_mcp_tool", "unity-pro", pushToolResult)

		expect(result).toBe(true)
	})

	it("fails open when the visibility check itself errors", async () => {
		const { task } = makeTask({
			mode: "code",
			hubOverrides: {
				getServers: vi.fn().mockImplementation(() => {
					throw new Error("hub not ready")
				}),
			},
		})

		const result = await ensureServerVisibleToMode(task, "use_mcp_tool", "unity-pro", pushToolResult)

		expect(result).toBe(true)
		expect(pushToolResult).not.toHaveBeenCalled()
	})
})

describe("execution-side visibility enforcement", () => {
	it("use_mcp_tool: does not execute nor ask approval for an invisible server", async () => {
		const { task, mcpHub } = makeTask({
			servers: makeServers([{ name: "unity-pro", modes: ["unity-context"], toolNames: ["outline"] }]),
			mode: "code",
		})
		const askApproval = vi.fn().mockResolvedValue(true)
		const handleError = vi.fn()
		const pushToolResult = vi.fn()

		await useMcpToolTool.handle(
			task,
			{
				type: "tool_use",
				id: "call_1",
				name: "use_mcp_tool",
				params: {
					server_name: "unity-pro",
					tool_name: "outline",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "unity-pro",
					tool_name: "outline",
					arguments: {},
				},
				partial: false,
			} as any,
			{ askApproval, handleError, pushToolResult },
		)

		expect(mcpHub.callTool).not.toHaveBeenCalled()
		expect(askApproval).not.toHaveBeenCalled()
		expect(handleError).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Tool error: Server 'unity-pro' is not visible to mode 'code'")
	})

	it("use_mcp_tool: executes normally for a visible server", async () => {
		const { task, mcpHub } = makeTask({
			servers: makeServers([{ name: "unity-pro", modes: ["unity-context"], toolNames: ["outline"] }]),
			mode: "unity-context",
		})
		const askApproval = vi.fn().mockResolvedValue(true)
		const handleError = vi.fn()
		const pushToolResult = vi.fn()

		await useMcpToolTool.handle(
			task,
			{
				type: "tool_use",
				id: "call_2",
				name: "use_mcp_tool",
				params: {
					server_name: "unity-pro",
					tool_name: "outline",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "unity-pro",
					tool_name: "outline",
					arguments: {},
				},
				partial: false,
			} as any,
			{ askApproval, handleError, pushToolResult },
		)

		expect(askApproval).toHaveBeenCalled()
		expect(mcpHub.callTool).toHaveBeenCalledWith("unity-pro", "outline", {})
	})

	it("access_mcp_resource: does not read nor ask approval for an invisible server", async () => {
		const { task, mcpHub } = makeTask({
			servers: makeServers([{ name: "unity-pro", modes: ["unity-context"] }]),
			mode: "code",
		})
		const askApproval = vi.fn().mockResolvedValue(true)
		const handleError = vi.fn()
		const pushToolResult = vi.fn()

		await accessMcpResourceTool.handle(
			task,
			{
				type: "tool_use",
				id: "call_3",
				name: "access_mcp_resource",
				params: {
					server_name: "unity-pro",
					uri: "unity://scene/main",
				},
				nativeArgs: {
					server_name: "unity-pro",
					uri: "unity://scene/main",
				},
				partial: false,
			} as any,
			{ askApproval, handleError, pushToolResult },
		)

		expect(mcpHub.readResource).not.toHaveBeenCalled()
		expect(askApproval).not.toHaveBeenCalled()
		expect(handleError).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Tool error: Server 'unity-pro' is not visible to mode 'code'")
	})
})
