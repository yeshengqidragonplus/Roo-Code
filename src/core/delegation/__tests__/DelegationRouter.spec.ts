// npx vitest run core/delegation/__tests__/DelegationRouter.spec.ts

import type { HistoryItem, TodoItem } from "@roo-code/types"

import { DelegationRouter, frameDelegationRequest, type DelegationRouterDeps } from "../DelegationRouter"

// Mock getModeBySlug so mode lookups are deterministic without vscode.
vi.mock("../../../shared/modes", () => ({
	getModeBySlug: vi.fn((slug: string, customModes?: any[]) => {
		const all = [...(customModes ?? []), ...BUILTIN_MODES]
		return all.find((m) => m.slug === slug)
	}),
}))

const BUILTIN_MODES = [
	{ slug: "code", name: "Code" },
	{ slug: "ask", name: "Ask" },
]

const EXPERT_MODE = { slug: "web-researcher", name: "Web Researcher", kind: "autonomous" }
const PLAIN_MODE = { slug: "code", name: "Code" }
const WORKGROUP_MODE = {
	slug: "zhangu-game-studio",
	name: "Studio",
	workgroup: { leadModeSlug: "arthur", colleagueSlugs: ["web-researcher"] },
}

function makeHistoryItem(overrides: Partial<HistoryItem> & { id: string }): HistoryItem {
	return {
		number: 1,
		ts: Date.now(),
		task: "test task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...overrides,
	} as HistoryItem
}

function makeDeps(overrides?: Partial<DelegationRouterDeps>): DelegationRouterDeps {
	return {
		getHistoryItems: vi.fn(() => []),
		getState: vi.fn(async () => ({ customModes: [EXPERT_MODE, WORKGROUP_MODE] })),
		delegateAndOpenChild: vi.fn(async () => ({ taskId: "child-1" }) as any),
		resumeLineSession: vi.fn(async () => ({ taskId: "line-1" }) as any),
		closeLine: vi.fn(async () => {}),
		log: vi.fn(),
		...overrides,
	}
}

describe("frameDelegationRequest", () => {
	it("wraps the message with number and origin", () => {
		const framed = frameDelegationRequest(3, "task-2", "investigate X")
		expect(framed).toContain('<delegation_request number="3" origin="task-2">')
		expect(framed).toContain("investigate X")
		expect(framed).toContain("</delegation_request>")
	})
})

describe("DelegationRouter.findLine", () => {
	it("finds an active line matching (origin, expert)", () => {
		const line = makeHistoryItem({
			id: "line-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "web-researcher",
			status: "active",
		})
		const deps = makeDeps({ getHistoryItems: () => [line] })
		const router = new DelegationRouter(deps)
		expect(router.findLine("task-2", "web-researcher")?.id).toBe("line-1")
	})

	it("finds an idle line (reusable)", () => {
		const line = makeHistoryItem({
			id: "line-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "web-researcher",
			status: "idle",
		})
		const deps = makeDeps({ getHistoryItems: () => [line] })
		const router = new DelegationRouter(deps)
		expect(router.findLine("task-2", "web-researcher")?.id).toBe("line-1")
	})

	it("ignores completed lines (closed, not reusable)", () => {
		const line = makeHistoryItem({
			id: "line-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "web-researcher",
			status: "completed",
		})
		const deps = makeDeps({ getHistoryItems: () => [line] })
		const router = new DelegationRouter(deps)
		expect(router.findLine("task-2", "web-researcher")).toBeUndefined()
	})

	it("ignores lines from a different origin (cross-origin isolation)", () => {
		const line = makeHistoryItem({
			id: "line-20-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-20",
			lineExpertMode: "web-researcher",
			status: "idle",
		})
		const deps = makeDeps({ getHistoryItems: () => [line] })
		const router = new DelegationRouter(deps)
		expect(router.findLine("task-2", "web-researcher")).toBeUndefined()
	})

	it("ignores lines for a different expert mode", () => {
		const line = makeHistoryItem({
			id: "line-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "unity-operator",
			status: "idle",
		})
		const deps = makeDeps({ getHistoryItems: () => [line] })
		const router = new DelegationRouter(deps)
		expect(router.findLine("task-2", "web-researcher")).toBeUndefined()
	})

	it("ignores non-line tasks entirely", () => {
		const plain = makeHistoryItem({ id: "task-9", status: "active" })
		const deps = makeDeps({ getHistoryItems: () => [plain] })
		const router = new DelegationRouter(deps)
		expect(router.findLine("task-9", "web-researcher")).toBeUndefined()
	})
})

describe("DelegationRouter.shouldUseLineRouting", () => {
	it("routes expert-kind targets through lines", async () => {
		const router = new DelegationRouter(makeDeps())
		expect(await router.shouldUseLineRouting("web-researcher")).toBe(true)
	})

	it("routes workgroup-originated delegations through lines", async () => {
		const router = new DelegationRouter(makeDeps())
		expect(await router.shouldUseLineRouting("code", "zhangu-game-studio")).toBe(true)
	})

	it("keeps plain-mode delegations on the legacy path", async () => {
		const router = new DelegationRouter(makeDeps())
		expect(await router.shouldUseLineRouting("code", "ask")).toBe(false)
	})
})

describe("DelegationRouter.routeDelegation", () => {
	it("creates a tagged line on first delegation to an expert", async () => {
		const delegateAndOpenChild = vi.fn(async () => ({ taskId: "child-1" }) as any)
		const router = new DelegationRouter(makeDeps({ delegateAndOpenChild }))

		const result = await router.routeDelegation({
			originTaskId: "task-2",
			expertMode: "web-researcher",
			message: "research X",
		})

		expect(result.reused).toBe(false)
		expect(delegateAndOpenChild).toHaveBeenCalledWith(
			expect.objectContaining({
				parentTaskId: "task-2",
				mode: "web-researcher",
				message: "research X",
				lineMetadata: { originTaskId: "task-2", expertMode: "web-researcher" },
			}),
		)
	})

	it("resumes an idle line on repeat delegation from the same origin", async () => {
		const line = makeHistoryItem({
			id: "line-2-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "web-researcher",
			status: "idle",
			lineRequestCount: 1,
		})
		const resumeLineSession = vi.fn(async () => ({ taskId: "line-2-1" }) as any)
		const delegateAndOpenChild = vi.fn(async () => ({ taskId: "child-new" }) as any)
		const router = new DelegationRouter(
			makeDeps({ getHistoryItems: () => [line], resumeLineSession, delegateAndOpenChild }),
		)

		const result = await router.routeDelegation({
			originTaskId: "task-2",
			expertMode: "web-researcher",
			message: "dig deeper into X",
		})

		expect(result.reused).toBe(true)
		expect(resumeLineSession).toHaveBeenCalledWith(
			expect.objectContaining({
				originTaskId: "task-2",
				lineHistoryItem: expect.objectContaining({ id: "line-2-1" }),
				message: "dig deeper into X",
			}),
		)
		expect(delegateAndOpenChild).not.toHaveBeenCalled()
	})

	it("rejects a request to a busy line while delegation is serial", async () => {
		const line = makeHistoryItem({
			id: "line-2-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "web-researcher",
			status: "active",
		})
		const resumeLineSession = vi.fn(async () => ({ taskId: "line-2-1" }) as any)
		const router = new DelegationRouter(makeDeps({ getHistoryItems: () => [line], resumeLineSession }))

		await expect(
			router.routeDelegation({
				originTaskId: "task-2",
				expertMode: "web-researcher",
				message: "another request",
			}),
		).rejects.toThrow(/is busy/)
		expect(resumeLineSession).not.toHaveBeenCalled()
	})

	it("uses the legacy path (no line metadata) for plain modes", async () => {
		const delegateAndOpenChild = vi.fn(async () => ({ taskId: "child-1" }) as any)
		const router = new DelegationRouter(makeDeps({ delegateAndOpenChild }))

		const result = await router.routeDelegation({
			originTaskId: "task-2",
			expertMode: "code",
			message: "do something",
			parentModeSlug: "ask",
		})

		expect(result.reused).toBe(false)
		const calls = vi.mocked(delegateAndOpenChild).mock.calls as any[]
		expect(calls.length).toBe(1)
		expect(calls[0][0].lineMetadata).toBeUndefined()
		expect(calls[0][0].mode).toBe("code")
	})

	it("throws for an unknown expert mode", async () => {
		const router = new DelegationRouter(makeDeps())
		await expect(
			router.routeDelegation({
				originTaskId: "task-2",
				expertMode: "no-such-mode",
				message: "x",
			}),
		).rejects.toThrow(/Invalid mode/)
	})

	it("passes images and todos through on line creation", async () => {
		const delegateAndOpenChild = vi.fn(async () => ({ taskId: "child-1" }) as any)
		const router = new DelegationRouter(makeDeps({ delegateAndOpenChild }))
		const todos: TodoItem[] = [{ id: "t1", content: "step", status: "pending" }]

		await router.routeDelegation({
			originTaskId: "task-2",
			expertMode: "web-researcher",
			message: "research X",
			images: ["data:image/png;base64,xxx"],
			initialTodos: todos,
		})

		expect(delegateAndOpenChild).toHaveBeenCalledWith(
			expect.objectContaining({
				images: ["data:image/png;base64,xxx"],
				initialTodos: todos,
			}),
		)
	})
})

describe("DelegationRouter rotation (Phase 4)", () => {
	it("rotates a line that served too many requests", async () => {
		const line = makeHistoryItem({
			id: "line-2-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "web-researcher",
			status: "idle",
			lineRequestCount: 20, // at the default cap
		})
		const resumeLineSession = vi.fn(async () => ({ taskId: "line-2-1" }) as any)
		const delegateAndOpenChild = vi.fn(async () => ({ taskId: "line-2-2" }) as any)
		const closeLine = vi.fn(async () => {})
		const router = new DelegationRouter(
			makeDeps({ getHistoryItems: () => [line], resumeLineSession, delegateAndOpenChild, closeLine }),
		)

		const result = await router.routeDelegation({
			originTaskId: "task-2",
			expertMode: "web-researcher",
			message: "next request",
		})

		expect(result.rotated).toBe(true)
		expect(result.reused).toBe(false)
		// Old line NOT resumed; a fresh line created via the legacy machinery
		expect(resumeLineSession).not.toHaveBeenCalled()
		expect(closeLine).toHaveBeenCalledWith(line)
		expect(delegateAndOpenChild).toHaveBeenCalledWith(
			expect.objectContaining({ lineMetadata: { originTaskId: "task-2", expertMode: "web-researcher" } }),
		)
	})

	it("rotates a line with too many consecutive failures", async () => {
		const line = makeHistoryItem({
			id: "line-2-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "web-researcher",
			status: "idle",
			lineRequestCount: 3,
			lineConsecutiveFailures: 3, // at the default cap
		})
		const resumeLineSession = vi.fn(async () => ({ taskId: "line-2-1" }) as any)
		const delegateAndOpenChild = vi.fn(async () => ({ taskId: "line-2-2" }) as any)
		const router = new DelegationRouter(
			makeDeps({ getHistoryItems: () => [line], resumeLineSession, delegateAndOpenChild }),
		)

		const result = await router.routeDelegation({
			originTaskId: "task-2",
			expertMode: "web-researcher",
			message: "next request",
		})

		expect(result.rotated).toBe(true)
		expect(resumeLineSession).not.toHaveBeenCalled()
	})

	it("does not rotate below the thresholds", async () => {
		const line = makeHistoryItem({
			id: "line-2-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "web-researcher",
			status: "idle",
			lineRequestCount: 5,
			lineConsecutiveFailures: 1,
		})
		const resumeLineSession = vi.fn(async () => ({ taskId: "line-2-1" }) as any)
		const router = new DelegationRouter(makeDeps({ getHistoryItems: () => [line], resumeLineSession }))

		const result = await router.routeDelegation({
			originTaskId: "task-2",
			expertMode: "web-researcher",
			message: "next request",
		})

		expect(result.rotated).toBeUndefined()
		expect(result.reused).toBe(true)
		expect(resumeLineSession).toHaveBeenCalled()
	})

	it("respects a custom rotation policy", async () => {
		const line = makeHistoryItem({
			id: "line-2-1",
			sessionKind: "expert-line",
			lineOriginTaskId: "task-2",
			lineExpertMode: "web-researcher",
			status: "idle",
			lineRequestCount: 2,
		})
		const resumeLineSession = vi.fn(async () => ({ taskId: "line-2-1" }) as any)
		const router = new DelegationRouter(makeDeps({ getHistoryItems: () => [line], resumeLineSession }), {
			maxRequestsPerLine: 2,
		})

		const result = await router.routeDelegation({
			originTaskId: "task-2",
			expertMode: "web-researcher",
			message: "next request",
		})

		expect(result.rotated).toBe(true)
	})
})
