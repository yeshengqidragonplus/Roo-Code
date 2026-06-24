import type { WorkflowEngine, WorkflowStep } from "@roo-code/types"

import { WorkflowExpertRunner, type WorkflowExpertRunnerDeps } from "../WorkflowExpertRunner"

/**
 * A scripted mock engine: `steps` is the sequence returned by start() then each
 * advance(). State is just the index, proving the host round-trips it back.
 */
function scriptedEngine(steps: WorkflowStep[]): WorkflowEngine {
	let i = 0
	return {
		start: () => steps[i++],
		advance: () => steps[i++],
	}
}

function makeDeps(overrides: Partial<WorkflowExpertRunnerDeps> = {}): {
	deps: WorkflowExpertRunnerDeps
	llmPrompts: string[]
	actions: unknown[]
	persisted: unknown[]
} {
	const llmPrompts: string[] = []
	const actions: unknown[] = []
	const persisted: unknown[] = []
	const deps: WorkflowExpertRunnerDeps = {
		runLlmTurn: async (prompt) => {
			llmPrompts.push(prompt)
			return `llm-result-for:${prompt}`
		},
		executeAction: async (action) => {
			actions.push(action)
			return `action-result:${action.type}`
		},
		persistState: async (state) => {
			persisted.push(state)
		},
		...overrides,
	}
	return { deps, llmPrompts, actions, persisted }
}

describe("WorkflowExpertRunner", () => {
	it("runs a soft-only workflow, one LLM turn per prompt", async () => {
		const engine = scriptedEngine([
			{ state: 0, nextPrompt: "step A", done: false },
			{ state: 1, nextPrompt: "step B", done: false },
			{ state: 2, done: true, finalResult: "all done" },
		])
		const { deps, llmPrompts, actions } = makeDeps()

		const result = await new WorkflowExpertRunner(engine, deps).run({ foo: 1 })

		expect(result).toBe("all done")
		expect(llmPrompts).toEqual(["step A", "step B"])
		expect(actions).toEqual([]) // no hard actions
	})

	it("executes a hard action without an LLM turn (mechanical step)", async () => {
		const engine = scriptedEngine([
			{ state: 0, action: { type: "tool", name: "read_file", params: { path: "x" } }, done: false },
			{ state: 1, done: true, finalResult: "ok" },
		])
		const { deps, llmPrompts, actions } = makeDeps()

		const result = await new WorkflowExpertRunner(engine, deps).run()

		expect(result).toBe("ok")
		expect(actions).toHaveLength(1)
		expect(llmPrompts).toEqual([]) // hard action spent no LLM turn
	})

	it("chains consecutive hard actions with no LLM turn between them", async () => {
		const engine = scriptedEngine([
			{ state: 0, action: { type: "tool", name: "a" }, done: false },
			{ state: 1, action: { type: "skill", name: "b" }, done: false },
			{ state: 2, done: true, finalResult: "done" },
		])
		const { deps, llmPrompts, actions } = makeDeps()

		await new WorkflowExpertRunner(engine, deps).run()

		expect(actions).toHaveLength(2)
		expect(llmPrompts).toEqual([])
	})

	it("interleaves soft and hard steps and persists state each step", async () => {
		const engine = scriptedEngine([
			{ state: "s0", action: { type: "tool", name: "read" }, done: false },
			{ state: "s1", nextPrompt: "now reason", done: false },
			{ state: "s2", action: { type: "delegate", expert: "tester", goal: "verify" }, done: false },
			{ state: "s3", done: true, finalResult: "complete" },
		])
		const { deps, llmPrompts, actions, persisted } = makeDeps()

		const result = await new WorkflowExpertRunner(engine, deps).run()

		expect(result).toBe("complete")
		expect(llmPrompts).toEqual(["now reason"])
		expect(actions.map((a: any) => a.type)).toEqual(["tool", "delegate"])
		// State persisted for every step including the terminal one.
		expect(persisted).toEqual(["s0", "s1", "s2", "s3"])
	})

	it("feeds the action/LLM result back into advance as lastOutput", async () => {
		const advanceArgs: Array<{ state: unknown; lastOutput: string }> = []
		const steps: WorkflowStep[] = [
			{ state: 0, nextPrompt: "p1", done: false },
			{ state: 1, done: true, finalResult: "fin" },
		]
		let i = 0
		const engine: WorkflowEngine = {
			start: () => steps[i++],
			advance: (state, lastOutput) => {
				advanceArgs.push({ state, lastOutput })
				return steps[i++]
			},
		}
		const { deps } = makeDeps()

		await new WorkflowExpertRunner(engine, deps).run()

		expect(advanceArgs).toEqual([{ state: 0, lastOutput: "llm-result-for:p1" }])
	})

	it("resumeFrom continues a run after a dispose→reopen", async () => {
		// Simulate: parent was disposed at a delegate step; on reopen we resume
		// from the persisted state with the sub-expert's summary as lastOutput.
		const advanceArgs: Array<{ state: unknown; lastOutput: string }> = []
		const steps: WorkflowStep[] = [{ state: "after-delegate", done: true, finalResult: "resumed-done" }]
		let i = 0
		const engine: WorkflowEngine = {
			start: () => {
				throw new Error("start should not be called on resume")
			},
			advance: (state, lastOutput) => {
				advanceArgs.push({ state, lastOutput })
				return steps[i++]
			},
		}
		const { deps } = makeDeps()

		const result = await new WorkflowExpertRunner(engine, deps).resumeFrom("persisted-state", "child summary")

		expect(result).toBe("resumed-done")
		expect(advanceArgs).toEqual([{ state: "persisted-state", lastOutput: "child summary" }])
	})

	it("throws on a malformed step that is not done and has neither action nor prompt", async () => {
		const engine = scriptedEngine([{ state: 0, done: false }])
		const { deps } = makeDeps()

		await expect(new WorkflowExpertRunner(engine, deps).run()).rejects.toThrow(/neither an action nor a nextPrompt/)
	})
})
