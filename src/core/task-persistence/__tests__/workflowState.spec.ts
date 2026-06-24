import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import { readWorkflowState, saveWorkflowState } from "../workflowState"
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
		await saveWorkflowState({ taskId, globalStoragePath: storage, workflowId: "wf", engineState: { step: 1 }, now: 1 })
		await saveWorkflowState({ taskId, globalStoragePath: storage, workflowId: "wf", engineState: { step: 2 }, now: 2 })
		const loaded = await readWorkflowState({ taskId, globalStoragePath: storage })
		expect(loaded?.engineState).toEqual({ step: 2 })
		expect(loaded?.lastUpdated).toBe(2)
	})
})
