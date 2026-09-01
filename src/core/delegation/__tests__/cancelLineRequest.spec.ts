// npx vitest run core/delegation/__tests__/cancelLineRequest.spec.ts

import type { HistoryItem } from "@roo-code/types"

/**
 * Tests for ClineProvider.cancelLineRequest — the user-initiated cancellation
 * of the current request on an expert line session.
 *
 * The provider method is exercised through a minimal fake `this` context so
 * the test focuses on the orchestration: abort the active line, mark it idle,
 * and resume the origin with a cancellation notice via
 * reopenParentFromDelegation.
 */

function makeHistoryItem(overrides: Partial<HistoryItem> & { id: string }): HistoryItem {
	return {
		number: 1,
		ts: Date.now(),
		task: "test",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...overrides,
	} as HistoryItem
}

describe("cancelLineRequest", () => {
	function buildProvider(overrides?: {
		lineHistory?: HistoryItem
		currentTaskId?: string
	}) {
		const lineHistory =
			overrides?.lineHistory ??
			makeHistoryItem({
				id: "line-2-1",
				sessionKind: "expert-line",
				lineOriginTaskId: "task-2",
				lineExpertMode: "web-researcher",
				status: "active",
			})

		const updateTaskHistoryCalls: any[] = []
		const reopenCalls: any[] = []
		const removedFromStack: boolean[] = []

		const fakeLineTask = {
			taskId: lineHistory.id,
			abortReason: undefined as string | undefined,
			cancelCurrentRequest: vi.fn(),
			abortTask: vi.fn(),
			abandoned: false,
		}

		const provider: any = {
			contextProxy: { globalStorageUri: { fsPath: "/mock/storage" } },
			getCurrentTask: vi.fn(() =>
				overrides?.currentTaskId === lineHistory.id ? fakeLineTask : undefined,
			),
			getTaskWithId: vi.fn(async (id: string) => {
				if (id === lineHistory.id) {
					// Return fresh state on subsequent reads (after idle write)
					const updated = updateTaskHistoryCalls.find((c) => c.id === lineHistory.id)
					return { historyItem: updated ?? lineHistory }
				}
				throw new Error("Task not found")
			}),
			updateTaskHistory: vi.fn(async (item: HistoryItem) => {
				updateTaskHistoryCalls.push(item)
				return [item]
			}),
			removeClineFromStack: vi.fn(async () => {
				removedFromStack.push(true)
			}),
			reopenParentFromDelegation: vi.fn(async (params: any) => {
				reopenCalls.push(params)
			}),
			log: vi.fn(),
		}

		return { provider, fakeLineTask, updateTaskHistoryCalls, reopenCalls, removedFromStack }
	}

	// Import the method under test from the compiled module. We re-implement
	// the call through the provider instance by binding the real method.
	async function callCancelLineRequest(provider: any, lineTaskId: string) {
		const { ClineProvider } = await import("../../webview/ClineProvider")
		const method = ClineProvider.prototype.cancelLineRequest
		return method.call(provider, lineTaskId)
	}

	it("aborts the active line, marks it idle, and resumes the origin with a cancellation notice", async () => {
		const { provider, fakeLineTask, updateTaskHistoryCalls, reopenCalls, removedFromStack } = buildProvider({
			currentTaskId: "line-2-1",
		})

		await callCancelLineRequest(provider, "line-2-1")

		// Line request aborted
		expect(fakeLineTask.abortReason).toBe("user_cancelled")
		expect(fakeLineTask.cancelCurrentRequest).toHaveBeenCalled()
		expect(fakeLineTask.abortTask).toHaveBeenCalled()
		expect(fakeLineTask.abandoned).toBe(true)
		expect(removedFromStack.length).toBe(1)

		// Line marked idle (survives for reuse)
		const idleWrite = updateTaskHistoryCalls.find((c) => c.id === "line-2-1")
		expect(idleWrite?.status).toBe("idle")

		// Origin resumed with cancellation notice
		expect(reopenCalls.length).toBe(1)
		expect(reopenCalls[0].parentTaskId).toBe("task-2")
		expect(reopenCalls[0].childTaskId).toBe("line-2-1")
		expect(reopenCalls[0].completionResultSummary).toContain("cancelled")
	})

	it("still resumes the origin when the line is not the active task (already stopped)", async () => {
		const { provider, reopenCalls, removedFromStack } = buildProvider({ currentTaskId: "other-task" })

		await callCancelLineRequest(provider, "line-2-1")

		// No active line to abort
		expect(removedFromStack.length).toBe(0)
		// Origin still gets the cancellation notice
		expect(reopenCalls.length).toBe(1)
		expect(reopenCalls[0].parentTaskId).toBe("task-2")
	})

	it("throws when the task is not an expert line session", async () => {
		const plain = makeHistoryItem({ id: "task-9", status: "active" })
		const { provider } = buildProvider({ lineHistory: plain })

		await expect(callCancelLineRequest(provider, "task-9")).rejects.toThrow(/not an expert line/)
	})

	it("throws when the line has no origin recorded", async () => {
		const orphan = makeHistoryItem({
			id: "line-x",
			sessionKind: "expert-line",
			status: "active",
			// lineOriginTaskId missing
		})
		const { provider } = buildProvider({ lineHistory: orphan })

		await expect(callCancelLineRequest(provider, "line-x")).rejects.toThrow(/no lineOriginTaskId/)
	})
})
