import type { ClineAsk } from "@roo-code/types"

import { checkAutoApproval, type AutoApprovalState, type AutoApprovalStateOptions } from "../index"

// Minimal state builder — only the fields checkAutoApproval reads.
type ApprovalState = Partial<Record<AutoApprovalState | AutoApprovalStateOptions, unknown>>
function state(overrides: ApprovalState = {}) {
	return overrides as Parameters<typeof checkAutoApproval>[0]["state"]
}

function toolText(tool: string, extra: Record<string, unknown> = {}) {
	return JSON.stringify({ tool, ...extra })
}

async function decide(args: { state?: ApprovalState; ask: ClineAsk; text?: string; isProtected?: boolean }) {
	return checkAutoApproval({
		state: state(args.state),
		ask: args.ask,
		text: args.text,
		isProtected: args.isProtected,
	})
}

describe("checkAutoApproval — zero-impact guarantee (manual / undefined mode)", () => {
	it("no state → ask (unchanged)", async () => {
		expect(await checkAutoApproval({ state: undefined, ask: "tool", text: toolText("readFile") })).toEqual({
			decision: "ask",
		})
	})

	it("autoApprovalEnabled off → ask, even for read-only (unchanged)", async () => {
		const result = await decide({
			state: { autoApprovalEnabled: false, alwaysAllowReadOnly: true },
			ask: "tool",
			text: toolText("readFile"),
		})
		expect(result).toEqual({ decision: "ask" })
	})

	it("legacy read-only approval still works when its toggle is on", async () => {
		const result = await decide({
			state: { autoApprovalEnabled: true, alwaysAllowReadOnly: true },
			ask: "tool",
			text: toolText("readFile"),
		})
		expect(result).toEqual({ decision: "approve" })
	})

	it("legacy write approval still gated by alwaysAllowWrite", async () => {
		const off = await decide({
			state: { autoApprovalEnabled: true, alwaysAllowWrite: false },
			ask: "tool",
			text: toolText("newFileCreated"),
		})
		expect(off).toEqual({ decision: "ask" })

		const on = await decide({
			state: { autoApprovalEnabled: true, alwaysAllowWrite: true },
			ask: "tool",
			text: toolText("newFileCreated"),
		})
		expect(on).toEqual({ decision: "approve" })
	})

	it("legacy followup countdown path is untouched in manual mode", async () => {
		const result = await decide({
			state: {
				autoApprovalEnabled: true,
				alwaysAllowFollowupQuestions: true,
				followupAutoApproveTimeoutMs: 5000,
			},
			ask: "followup",
			text: JSON.stringify({ suggest: [{ answer: "yes" }] }),
		})
		expect(result.decision).toBe("timeout")
	})
})

describe("checkAutoApproval — sandbox mode (L1)", () => {
	const sandbox: ApprovalState = { autoApprovalMode: "sandbox" }

	it("does not require autoApprovalEnabled (the mode is the enablement)", async () => {
		const result = await decide({
			state: { ...sandbox, autoApprovalEnabled: false },
			ask: "tool",
			text: toolText("readFile"),
		})
		expect(result).toEqual({ decision: "approve" })
	})

	describe("files", () => {
		it("read inside workspace → approve", async () => {
			expect(await decide({ state: sandbox, ask: "tool", text: toolText("readFile") })).toEqual({
				decision: "approve",
			})
		})

		it("read outside workspace → ask", async () => {
			expect(
				await decide({ state: sandbox, ask: "tool", text: toolText("readFile", { isOutsideWorkspace: true }) }),
			).toEqual({ decision: "ask" })
		})

		it("write inside workspace → approve", async () => {
			expect(await decide({ state: sandbox, ask: "tool", text: toolText("editedExistingFile") })).toEqual({
				decision: "approve",
			})
		})

		it("write outside workspace → ask", async () => {
			expect(
				await decide({
					state: sandbox,
					ask: "tool",
					text: toolText("editedExistingFile", { isOutsideWorkspace: true }),
				}),
			).toEqual({ decision: "ask" })
		})

		it("write to a protected (red-line) file → ask even inside workspace", async () => {
			expect(
				await decide({
					state: sandbox,
					ask: "tool",
					text: toolText("newFileCreated"),
					isProtected: true,
				}),
			).toEqual({ decision: "ask" })
		})
	})

	describe("commands", () => {
		it("trusted-list command → approve", async () => {
			expect(
				await decide({ state: { ...sandbox, allowedCommands: ["npm"] }, ask: "command", text: "npm test" }),
			).toEqual({ decision: "approve" })
		})

		it("unknown command → ask", async () => {
			expect(await decide({ state: sandbox, ask: "command", text: "some-random-binary" })).toEqual({
				decision: "ask",
			})
		})

		it("denied-list command → deny", async () => {
			expect(
				await decide({
					state: { ...sandbox, allowedCommands: ["*"], deniedCommands: ["rm"] },
					ask: "command",
					text: "rm -rf /",
				}),
			).toEqual({ decision: "deny" })
		})
	})

	describe("other asks", () => {
		it("follow-up question → ask (never a countdown in sandbox mode)", async () => {
			const result = await decide({
				state: { ...sandbox, alwaysAllowFollowupQuestions: true, followupAutoApproveTimeoutMs: 5000 },
				ask: "followup",
				text: JSON.stringify({ suggest: [{ answer: "yes" }] }),
			})
			expect(result).toEqual({ decision: "ask" })
		})

		it("MCP tool not marked always-allow → ask", async () => {
			expect(
				await decide({
					state: sandbox,
					ask: "use_mcp_server",
					text: JSON.stringify({ type: "use_mcp_tool", serverName: "s", toolName: "t" }),
				}),
			).toEqual({ decision: "ask" })
		})

		it("MCP tool marked always-allow → approve", async () => {
			const mcpServers = [{ name: "s", tools: [{ name: "t", alwaysAllow: true }] }]
			expect(
				await decide({
					state: { ...sandbox, mcpServers },
					ask: "use_mcp_server",
					text: JSON.stringify({ type: "use_mcp_tool", serverName: "s", toolName: "t" }),
				}),
			).toEqual({ decision: "approve" })
		})

		it("mode switch and subtasks → approve", async () => {
			expect(await decide({ state: sandbox, ask: "tool", text: toolText("switchMode") })).toEqual({
				decision: "approve",
			})
			expect(await decide({ state: sandbox, ask: "tool", text: toolText("newTask") })).toEqual({
				decision: "approve",
			})
		})

		it("todo list and skill loading → approve", async () => {
			expect(await decide({ state: sandbox, ask: "tool", text: toolText("updateTodoList") })).toEqual({
				decision: "approve",
			})
			expect(await decide({ state: sandbox, ask: "tool", text: toolText("skill") })).toEqual({
				decision: "approve",
			})
		})
	})
})
