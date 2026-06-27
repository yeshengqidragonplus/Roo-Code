import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	HostToolInvoker,
	toolCategoryFor,
	hasSideEffect,
	buildReadOnlyToolRegistry,
	buildFullToolRegistry,
} from "../HostToolInvoker"
import type { ToolPolicy } from "@roo-code/types"
import type { Task } from "../../task/Task"
import type { ToolUse, ToolResponse } from "../../../shared/tools"
import type { BaseTool, ToolCallbacks } from "../../tools/BaseTool"

/** A minimal mock tool that calls pushToolResult with a canned value. */
function mockTool(opts: { name?: string; result?: ToolResponse; throwInHandle?: Error }): BaseTool<any> {
	const result = opts.result ?? "tool output"
	return {
		name: opts.name ?? "read_file",
		async handle(_task: Task, _block: ToolUse, callbacks: ToolCallbacks): Promise<void> {
			if (opts.throwInHandle) {
				await callbacks.handleError("executing", opts.throwInHandle)
				return
			}
			callbacks.pushToolResult(result)
		},
	} as unknown as BaseTool<any>
}

function makeDeps(
	overrides: Partial<{
		getTool: ReturnType<typeof vi.fn>
		say: ReturnType<typeof vi.fn>
		askApproval: ReturnType<typeof vi.fn>
		saveCheckpoint: ReturnType<typeof vi.fn>
		restoreCheckpoint: ReturnType<typeof vi.fn>
	}> = {},
) {
	return {
		getTool: overrides.getTool ?? vi.fn(() => undefined),
		say: overrides.say ?? vi.fn().mockResolvedValue(undefined),
		askApproval: overrides.askApproval ?? vi.fn().mockResolvedValue(true),
		saveCheckpoint: overrides.saveCheckpoint ?? vi.fn().mockResolvedValue("ckpt-hash-123"),
		restoreCheckpoint: overrides.restoreCheckpoint ?? vi.fn().mockResolvedValue(undefined),
	}
}

describe("toolCategoryFor", () => {
	it("maps read-only built-ins to 'read'", () => {
		expect(toolCategoryFor("read_file")).toBe("read")
		expect(toolCategoryFor("list_files")).toBe("read")
		expect(toolCategoryFor("codebase_search")).toBe("read")
		expect(toolCategoryFor("search_files")).toBe("read")
	})

	it("maps edit tools to 'edit'", () => {
		expect(toolCategoryFor("write_to_file")).toBe("edit")
		expect(toolCategoryFor("apply_diff")).toBe("edit")
	})

	it("maps command tools to 'command'", () => {
		expect(toolCategoryFor("execute_command")).toBe("command")
	})

	it("maps mcp tools to 'mcp'", () => {
		expect(toolCategoryFor("use_mcp_tool")).toBe("mcp")
	})

	it("returns undefined for unknown names", () => {
		expect(toolCategoryFor("crawler_a")).toBeUndefined()
		expect(toolCategoryFor("some_custom_thing")).toBeUndefined()
	})
})

describe("HostToolInvoker", () => {
	let task: any

	beforeEach(() => {
		task = {
			// Sentinel: the invoker must NEVER touch userMessageContent.
			userMessageContent: [],
			consecutiveMistakeCount: 0,
		}
	})

	describe("permission (§4.2)", () => {
		it("rejects when no toolPolicy is declared (fail-safe)", async () => {
			const deps = makeDeps({ getTool: vi.fn(() => mockTool({})) })
			const invoker = new HostToolInvoker(deps)
			await expect(
				invoker.invoke(task as Task, { type: "tool", name: "read_file", params: {} }, undefined),
			).rejects.toThrow(/no `toolPolicy`/)
			expect(deps.getTool).not.toHaveBeenCalled()
		})

		it("rejects when the tool is not in allowedTools and its category is not in allowedCategories", async () => {
			const deps = makeDeps({ getTool: vi.fn(() => mockTool({})) })
			const invoker = new HostToolInvoker(deps)
			const policy: ToolPolicy = { allowedTools: ["other_tool"] }
			await expect(
				invoker.invoke(task as Task, { type: "tool", name: "read_file", params: {} }, policy),
			).rejects.toThrow(/not allowed by the expert's `toolPolicy`/)
		})

		it("allows when the tool name is in allowedTools", async () => {
			const tool = mockTool({ result: "ok" })
			const deps = makeDeps({ getTool: vi.fn(() => tool) })
			const invoker = new HostToolInvoker(deps)
			const res = await invoker.invoke(
				task as Task,
				{ type: "tool", name: "crawler_a", params: {} },
				{ allowedTools: ["crawler_a"] },
			)
			expect(res.output).toBe("ok")
			expect(res.isError).toBe(false)
		})

		it("allows when the tool's category is in allowedCategories", async () => {
			const tool = mockTool({ name: "read_file", result: "contents" })
			const deps = makeDeps({ getTool: vi.fn(() => tool) })
			const invoker = new HostToolInvoker(deps)
			const res = await invoker.invoke(
				task as Task,
				{ type: "tool", name: "read_file", params: { path: "a.ts" } },
				{ allowedCategories: ["read"] },
			)
			expect(res.output).toBe("contents")
		})

		it("rejects an edit tool when only 'read' category is allowed", async () => {
			const tool = mockTool({ name: "write_to_file", result: "wrote" })
			const deps = makeDeps({ getTool: vi.fn(() => tool) })
			const invoker = new HostToolInvoker(deps)
			await expect(
				invoker.invoke(
					task as Task,
					{ type: "tool", name: "write_to_file", params: {} },
					{ allowedCategories: ["read"] },
				),
			).rejects.toThrow(/not allowed/)
		})
	})

	describe("execution + result capture", () => {
		it("captures the tool result and returns it as text", async () => {
			const tool = mockTool({ result: "file contents here" })
			const deps = makeDeps({ getTool: vi.fn(() => tool) })
			const invoker = new HostToolInvoker(deps)
			const res = await invoker.invoke(
				task as Task,
				{ type: "tool", name: "read_file", params: { path: "a.ts" } },
				{ allowedTools: ["read_file"] },
			)
			expect(res.output).toBe("file contents here")
			expect(res.isError).toBe(false)
		})

		it("flattens content-block results to text", async () => {
			const tool = mockTool({
				result: [
					{ type: "text", text: "line 1" },
					{ type: "text", text: "line 2" },
				],
			})
			const deps = makeDeps({ getTool: vi.fn(() => tool) })
			const invoker = new HostToolInvoker(deps)
			const res = await invoker.invoke(
				task as Task,
				{ type: "tool", name: "read_file", params: {} },
				{ allowedTools: ["read_file"] },
			)
			expect(res.output).toBe("line 1\nline 2")
		})

		it("does NOT write to task.userMessageContent (no dangling tool_result)", async () => {
			const tool = mockTool({ result: "ok" })
			const deps = makeDeps({ getTool: vi.fn(() => tool) })
			const invoker = new HostToolInvoker(deps)
			await invoker.invoke(
				task as Task,
				{ type: "tool", name: "read_file", params: {} },
				{ allowedTools: ["read_file"] },
			)
			expect(task.userMessageContent).toEqual([])
		})

		it("throws when the tool reports an error via handleError", async () => {
			const tool = mockTool({ throwInHandle: new Error("disk on fire") })
			const deps = makeDeps({ getTool: vi.fn(() => tool) })
			const invoker = new HostToolInvoker(deps)
			await expect(
				invoker.invoke(
					task as Task,
					{ type: "tool", name: "read_file", params: {} },
					{ allowedTools: ["read_file"] },
				),
			).rejects.toThrow(/disk on fire/)
		})

		it("throws when the tool is not registered", async () => {
			const deps = makeDeps({ getTool: vi.fn(() => undefined) })
			const invoker = new HostToolInvoker(deps)
			await expect(
				invoker.invoke(
					task as Task,
					{ type: "tool", name: "read_file", params: {} },
					{ allowedTools: ["read_file"] },
				),
			).rejects.toThrow(/not registered/)
		})
	})

	describe("approval (§4.3)", () => {
		it("asks for approval with a labeled workflowStep message", async () => {
			const tool = mockTool({ result: "ok" })
			const askApproval = vi.fn().mockResolvedValue(true)
			const deps = makeDeps({ getTool: vi.fn(() => tool), askApproval })
			const invoker = new HostToolInvoker(deps)
			await invoker.invoke(
				task as Task,
				{ type: "tool", name: "read_file", params: { path: "a.ts" } },
				{ allowedTools: ["read_file"] },
			)
			expect(askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("workflowStep"))
			expect(askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("read_file"))
		})

		it("returns an error result when approval is denied (does not throw)", async () => {
			const tool = mockTool({ result: "ok" })
			const askApproval = vi.fn().mockResolvedValue(false)
			const deps = makeDeps({ getTool: vi.fn(() => tool), askApproval })
			const invoker = new HostToolInvoker(deps)
			const res = await invoker.invoke(
				task as Task,
				{ type: "tool", name: "read_file", params: {} },
				{ allowedTools: ["read_file"] },
			)
			expect(res.isError).toBe(true)
			expect(res.output).toMatch(/not approved/)
			// Tool was never executed.
			expect(deps.say).not.toHaveBeenCalled()
		})
	})

	describe("audit trail (§4.4)", () => {
		it("emits a 'tool' say message recording the mechanical invocation", async () => {
			const tool = mockTool({ result: "ok" })
			const say = vi.fn().mockResolvedValue(undefined)
			const deps = makeDeps({ getTool: vi.fn(() => tool), say })
			const invoker = new HostToolInvoker(deps)
			await invoker.invoke(
				task as Task,
				{ type: "tool", name: "list_files", params: { path: "." } },
				{ allowedTools: ["list_files"] },
			)
			expect(say).toHaveBeenCalledWith("tool", expect.stringContaining("list_files"))
			expect(say).toHaveBeenCalledWith("tool", expect.stringContaining("Mechanically executing"))
		})
	})

	describe("buildReadOnlyToolRegistry", () => {
		it("registers the four read-only built-in tools", () => {
			const reg = buildReadOnlyToolRegistry({
				readFileTool: mockTool({ name: "read_file" }),
				listFilesTool: mockTool({ name: "list_files" }),
				codebaseSearchTool: mockTool({ name: "codebase_search" }),
				searchFilesTool: mockTool({ name: "search_files" }),
			})
			expect(reg.get("read_file")).toBeDefined()
			expect(reg.get("list_files")).toBeDefined()
			expect(reg.get("codebase_search")).toBeDefined()
			expect(reg.get("search_files")).toBeDefined()
			expect(reg.get("write_to_file")).toBeUndefined()
		})
	})

	describe("hasSideEffect (3c)", () => {
		it("returns false for read-only tools", () => {
			expect(hasSideEffect("read_file")).toBe(false)
			expect(hasSideEffect("list_files")).toBe(false)
			expect(hasSideEffect("codebase_search")).toBe(false)
		})

		it("returns true for edit/command/skill tools", () => {
			expect(hasSideEffect("write_to_file")).toBe(true)
			expect(hasSideEffect("apply_diff")).toBe(true)
			expect(hasSideEffect("execute_command")).toBe(true)
			expect(hasSideEffect("skill")).toBe(true)
		})
	})

	describe("skill action adaptation (3c)", () => {
		it("maps a skill action to the skill tool's {skill, args} param shape", async () => {
			const tool = mockTool({ name: "skill", result: "skill ran" })
			const capturedBlocks: ToolUse[] = []
			const deps = makeDeps({
				getTool: vi.fn(() => ({
					name: "skill",
					async handle(_t: Task, block: ToolUse, cb: ToolCallbacks) {
						capturedBlocks.push(block)
						cb.pushToolResult("skill ran")
					},
				})),
			})
			const invoker = new HostToolInvoker(deps)
			const res = await invoker.invoke(
				task as Task,
				{ type: "skill", name: "my-skill", args: { x: 1 } },
				// A skill action's name is the skill name, not "skill"; authorize
				// via the "skill" category instead.
				{ allowedCategories: ["skill"] },
			)
			expect(res.output).toBe("skill ran")
			// The synthesized block keeps the action name; nativeArgs maps it to the
			// skill tool's {skill, args} param shape (args JSON-stringified).
			expect(capturedBlocks[0].name).toBe("my-skill")
			expect(capturedBlocks[0].nativeArgs).toMatchObject({ skill: "my-skill" })
		})
	})

	describe("approval strategy (3c)", () => {
		it("does NOT invoker-approve side-effecting tools (they self-approve)", async () => {
			const tool = mockTool({ name: "write_to_file", result: "wrote" })
			const askApproval = vi.fn().mockResolvedValue(true)
			const deps = makeDeps({ getTool: vi.fn(() => tool), askApproval })
			const invoker = new HostToolInvoker(deps)
			await invoker.invoke(
				task as Task,
				{ type: "tool", name: "write_to_file", params: { path: "a" } },
				{ allowedTools: ["write_to_file"] },
			)
			// write_to_file runs its own askApproval internally; invoker must not
			// double-prompt.
			expect(askApproval).not.toHaveBeenCalled()
		})

		it("still invoker-approves read-only tools (they don't self-approve)", async () => {
			const tool = mockTool({ name: "read_file", result: "ok" })
			const askApproval = vi.fn().mockResolvedValue(true)
			const deps = makeDeps({ getTool: vi.fn(() => tool), askApproval })
			const invoker = new HostToolInvoker(deps)
			await invoker.invoke(
				task as Task,
				{ type: "tool", name: "read_file", params: {} },
				{ allowedTools: ["read_file"] },
			)
			expect(askApproval).toHaveBeenCalledTimes(1)
		})
	})

	describe("checkpoint save/restore (3c)", () => {
		it("saves a checkpoint before a side-effecting tool runs", async () => {
			const tool = mockTool({ name: "write_to_file", result: "wrote" })
			const saveCheckpoint = vi.fn().mockResolvedValue("hash-abc")
			const restoreCheckpoint = vi.fn().mockResolvedValue(undefined)
			const deps = makeDeps({
				getTool: vi.fn(() => tool),
				saveCheckpoint,
				restoreCheckpoint,
			})
			const invoker = new HostToolInvoker(deps)
			await invoker.invoke(
				task as Task,
				{ type: "tool", name: "write_to_file", params: { path: "a" } },
				{ allowedTools: ["write_to_file"] },
			)
			expect(saveCheckpoint).toHaveBeenCalledTimes(1)
			// Success → no restore.
			expect(restoreCheckpoint).not.toHaveBeenCalled()
		})

		it("does NOT save a checkpoint for read-only tools", async () => {
			const tool = mockTool({ name: "read_file", result: "ok" })
			const saveCheckpoint = vi.fn().mockResolvedValue("hash")
			const deps = makeDeps({ getTool: vi.fn(() => tool), saveCheckpoint })
			const invoker = new HostToolInvoker(deps)
			await invoker.invoke(
				task as Task,
				{ type: "tool", name: "read_file", params: {} },
				{ allowedTools: ["read_file"] },
			)
			expect(saveCheckpoint).not.toHaveBeenCalled()
		})

		it("restores the checkpoint when a side-effecting tool throws", async () => {
			const tool = mockTool({ name: "write_to_file", throwInHandle: new Error("disk full") })
			const saveCheckpoint = vi.fn().mockResolvedValue("hash-xyz")
			const restoreCheckpoint = vi.fn().mockResolvedValue(undefined)
			const deps = makeDeps({
				getTool: vi.fn(() => tool),
				saveCheckpoint,
				restoreCheckpoint,
			})
			const invoker = new HostToolInvoker(deps)
			await expect(
				invoker.invoke(
					task as Task,
					{ type: "tool", name: "write_to_file", params: { path: "a" } },
					{ allowedTools: ["write_to_file"] },
				),
			).rejects.toThrow(/disk full/)
			expect(saveCheckpoint).toHaveBeenCalledTimes(1)
			expect(restoreCheckpoint).toHaveBeenCalledWith("hash-xyz")
		})

		it("logs but does not mask the original error when restore itself fails", async () => {
			const tool = mockTool({ name: "write_to_file", throwInHandle: new Error("write failed") })
			const saveCheckpoint = vi.fn().mockResolvedValue("hash-1")
			const restoreCheckpoint = vi.fn().mockRejectedValue(new Error("restore failed"))
			const deps = makeDeps({
				getTool: vi.fn(() => tool),
				saveCheckpoint,
				restoreCheckpoint,
			})
			const invoker = new HostToolInvoker(deps)
			// Original tool error surfaces, not the restore error.
			await expect(
				invoker.invoke(
					task as Task,
					{ type: "tool", name: "write_to_file", params: {} },
					{ allowedTools: ["write_to_file"] },
				),
			).rejects.toThrow(/write failed/)
		})
	})

	describe("buildFullToolRegistry (3c)", () => {
		it("registers read-only + side-effecting + skill tools", () => {
			const reg = buildFullToolRegistry({
				readFileTool: mockTool({ name: "read_file" }),
				listFilesTool: mockTool({ name: "list_files" }),
				codebaseSearchTool: mockTool({ name: "codebase_search" }),
				searchFilesTool: mockTool({ name: "search_files" }),
				writeToFileTool: mockTool({ name: "write_to_file" }),
				applyDiffTool: mockTool({ name: "apply_diff" }),
				editTool: mockTool({ name: "edit" }),
				searchReplaceTool: mockTool({ name: "search_replace" }),
				editFileTool: mockTool({ name: "edit_file" }),
				applyPatchTool: mockTool({ name: "apply_patch" }),
				executeCommandTool: mockTool({ name: "execute_command" }),
				skillTool: mockTool({ name: "skill" }),
			})
			// Read-only (3a).
			expect(reg.get("read_file")).toBeDefined()
			// Side-effecting (3c).
			expect(reg.get("write_to_file")).toBeDefined()
			expect(reg.get("apply_diff")).toBeDefined()
			expect(reg.get("edit")).toBeDefined()
			expect(reg.get("execute_command")).toBeDefined()
			expect(reg.get("skill")).toBeDefined()
			// MCP (3b) still excluded.
			expect(reg.get("use_mcp_tool")).toBeUndefined()
		})
	})
})
