import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import {
	readWorkflowState,
	saveWorkflowState,
	markWorkflowPendingDelegation,
	clearWorkflowPendingDelegation,
} from "../workflowState"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { GlobalFileNames } from "../../../shared/globalFileNames"

let storage: string
const taskId = "task-A"

beforeEach(async () => {
	storage = await fs.mkdtemp(path.join(os.tmpdir(), "wfstate-"))
})

afterEach(async () => {
	await fs.rm(storage, { recursive: true, force: true })
})

describe("workflowState persistence", () => {
	it("round-trips a saved workflow state", async () => {
		const engineState = { currentNodeId: "cls", results: { read: { output: "x" } }, done: false }
		await saveWorkflowState({
			taskId,
			globalStoragePath: storage,
			workflowId: "release-flow",
			engineState,
			now: 1719300000000,
		})

		const loaded = await readWorkflowState({ taskId, globalStoragePath: storage })
		expect(loaded).toEqual({ workflowId: "release-flow", engineState, lastUpdated: 1719300000000 })
	})

	it("returns undefined when no state file exists", async () => {
		expect(await readWorkflowState({ taskId, globalStoragePath: storage })).toBeUndefined()
	})

	it("returns undefined and does not throw on malformed JSON", async () => {
		const taskDir = await getTaskDirectoryPath(storage, taskId)
		await fs.writeFile(path.join(taskDir, GlobalFileNames.workflowState), "{ broken")
		expect(await readWorkflowState({ taskId, globalStoragePath: storage })).toBeUndefined()
	})

	it("returns undefined when the record lacks a workflowId", async () => {
		const taskDir = await getTaskDirectoryPath(storage, taskId)
		await fs.writeFile(path.join(taskDir, GlobalFileNames.workflowState), JSON.stringify({ engineState: {} }))
		expect(await readWorkflowState({ taskId, globalStoragePath: storage })).toBeUndefined()
	})

	it("overwrites prior state on subsequent saves", async () => {
		await saveWorkflowState({
			taskId,
			globalStoragePath: storage,
			workflowId: "wf",
			engineState: { step: 1 },
			now: 1,
		})
		await saveWorkflowState({
			taskId,
			globalStoragePath: storage,
			workflowId: "wf",
			engineState: { step: 2 },
			now: 2,
		})
		const loaded = await readWorkflowState({ taskId, globalStoragePath: storage })
		expect(loaded?.engineState).toEqual({ step: 2 })
		expect(loaded?.lastUpdated).toBe(2)
	})

	describe("pendingDelegation marker (Phase 2)", () => {
		it("mark adds the marker while preserving engine state", async () => {
			await saveWorkflowState({
				taskId,
				globalStoragePath: storage,
				workflowId: "wf",
				engineState: { step: 7 },
				now: 5,
			})
			await markWorkflowPendingDelegation({ taskId, globalStoragePath: storage, expert: "code" })
			const loaded = await readWorkflowState({ taskId, globalStoragePath: storage })
			expect(loaded).toEqual({
				workflowId: "wf",
				engineState: { step: 7 },
				lastUpdated: 5,
				pendingDelegation: { expert: "code" },
			})
		})

		it("a subsequent saveWorkflowState drops the marker (clear-on-advance)", async () => {
			await saveWorkflowState({
				taskId,
				globalStoragePath: storage,
				workflowId: "wf",
				engineState: { step: 7 },
				now: 5,
			})
			await markWorkflowPendingDelegation({ taskId, globalStoragePath: storage, expert: "code" })
			await saveWorkflowState({
				taskId,
				globalStoragePath: storage,
				workflowId: "wf",
				engineState: { step: 8 },
				now: 6,
			})
			const loaded = await readWorkflowState({ taskId, globalStoragePath: storage })
			expect(loaded?.pendingDelegation).toBeUndefined()
			expect(loaded?.engineState).toEqual({ step: 8 })
		})

		it("clear removes the marker and is idempotent when absent", async () => {
			await saveWorkflowState({
				taskId,
				globalStoragePath: storage,
				workflowId: "wf",
				engineState: { step: 1 },
				now: 1,
			})
			await markWorkflowPendingDelegation({ taskId, globalStoragePath: storage, expert: "code" })
			await clearWorkflowPendingDelegation({ taskId, globalStoragePath: storage })
			expect((await readWorkflowState({ taskId, globalStoragePath: storage }))?.pendingDelegation).toBeUndefined()
			// idempotent second call
			await clearWorkflowPendingDelegation({ taskId, globalStoragePath: storage })
			const loaded = await readWorkflowState({ taskId, globalStoragePath: storage })
			expect(loaded?.engineState).toEqual({ step: 1 })
		})

		it("mark is a no-op (warns) when there is no existing state", async () => {
			await markWorkflowPendingDelegation({ taskId, globalStoragePath: storage, expert: "code" })
			expect(await readWorkflowState({ taskId, globalStoragePath: storage })).toBeUndefined()
		})
	})
})
