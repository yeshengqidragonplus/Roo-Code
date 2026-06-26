import type { WorkflowEngine, WorkflowStep } from "@roo-code/types"

import { WorkflowSession, frameWorkflowStepPrompt, type WorkflowSessionDeps } from "../WorkflowSession"

function scriptedEngine(steps: WorkflowStep[]): WorkflowEngine {
	let i = 0
	return {
		start: () => steps[i++],
		advance: () => steps[i++],
	}
}

function makeDeps(engine: WorkflowEngine, persisted: unknown[] = []): WorkflowSessionDeps {
	return {
		createEngine: async () => engine,
		persist: async (_id, state) => {
			persisted.push(state)
		},
	}
}

describe("WorkflowSession", () => {
	it("start returns the first soft prompt and persists state", async () => {
		const persisted: unknown[] = []
		const engine = scriptedEngine([{ state: { i: 0 }, nextPrompt: "do step 1", done: false }])
		const { session, turn } = await WorkflowSession.start("wf", { goal: "x" }, makeDeps(engine, persisted))

		expect(turn).toEqual({ prompt: "do step 1", done: false })
		expect(session.workflowId).toBe("wf")
		expect(persisted).toEqual([{ i: 0 }])
	})

	it("advances step-by-step until done, returning finalResult", async () => {
		const engine = scriptedEngine([
			{ state: 0, nextPrompt: "step 1", done: false },
			{ state: 1, nextPrompt: "step 2", done: false },
			{ state: 2, done: true, finalResult: "all done" },
		])
		const { session, turn: t0 } = await WorkflowSession.start("wf", {}, makeDeps(engine))
		expect(t0.prompt).toBe("step 1")

		const t1 = await session.advance("step 1 output")
		expect(t1).toEqual({ prompt: "step 2", done: false })

		const t2 = await session.advance("step 2 output")
		expect(t2).toEqual({ done: true, finalResult: "all done" })
	})

	it("feeds the previous step output into engine.advance", async () => {
		const advanceArgs: Array<{ state: unknown; lastOutput: unknown }> = []
		const steps: WorkflowStep[] = [
			{ state: "s0", nextPrompt: "p", done: false },
			{ state: "s1", done: true, finalResult: "fin" },
		]
		let i = 0
		const engine: WorkflowEngine = {
			start: () => steps[i++],
			advance: (state, lastOutput) => {
				advanceArgs.push({ state, lastOutput })
				return steps[i++]
			},
		}
		const { session } = await WorkflowSession.start("wf", {}, makeDeps(engine))
		await session.advance("the stage result")
		expect(advanceArgs).toEqual([{ state: "s0", lastOutput: "the stage result" }])
	})

	it("resume rebuilds from persisted state and continues advancing", async () => {
		const advanceArgs: Array<{ state: unknown; lastOutput: unknown }> = []
		const engine: WorkflowEngine = {
			start: () => {
				throw new Error("start must not be called on resume")
			},
			advance: (state, lastOutput) => {
				advanceArgs.push({ state, lastOutput })
				return { state: "next", done: true, finalResult: "resumed" }
			},
		}
		const session = await WorkflowSession.resume("wf", "persisted-state", makeDeps(engine))
		const turn = await session.advance("output after resume")
		expect(turn).toEqual({ done: true, finalResult: "resumed" })
		expect(advanceArgs).toEqual([{ state: "persisted-state", lastOutput: "output after resume" }])
	})

	it("surfaces a delegate action as turn.delegate (Phase 2)", async () => {
		const engine = scriptedEngine([
			{ state: 0, action: { type: "delegate", expert: "code", goal: "write the doc" }, done: false },
		])
		const { turn } = await WorkflowSession.start("wf", {}, makeDeps(engine))
		expect(turn).toEqual({ delegate: { expert: "code", goal: "write the doc" }, done: false })
	})

	it("advance can return a delegate turn, feeding the prior output to the engine", async () => {
		const advanceArgs: Array<{ state: unknown; lastOutput: unknown }> = []
		const steps: WorkflowStep[] = [
			{ state: "s0", nextPrompt: "plan it", done: false },
			{ state: "s1", action: { type: "delegate", expert: "code", goal: "write it" }, done: false },
		]
		let i = 0
		const engine: WorkflowEngine = {
			start: () => steps[i++],
			advance: (state, lastOutput) => {
				advanceArgs.push({ state, lastOutput })
				return steps[i++]
			},
		}
		const { session } = await WorkflowSession.start("wf", {}, makeDeps(engine))
		const turn = await session.advance("the plan")
		expect(turn).toEqual({ delegate: { expert: "code", goal: "write it" }, done: false })
		expect(advanceArgs).toEqual([{ state: "s0", lastOutput: "the plan" }])
	})

	it("throws a clear Phase 3 error on tool/skill hard actions", async () => {
		const toolEngine = scriptedEngine([
			{ state: 0, action: { type: "tool", name: "read", params: {} }, done: false },
		])
		await expect(WorkflowSession.start("wf", {}, makeDeps(toolEngine))).rejects.toThrow(/Phase 3/)

		const skillEngine = scriptedEngine([{ state: 0, action: { type: "skill", name: "x", args: {} }, done: false }])
		await expect(WorkflowSession.start("wf", {}, makeDeps(skillEngine))).rejects.toThrow(/Phase 3/)
	})

	it("throws when a non-done step has no prompt", async () => {
		const engine = scriptedEngine([{ state: 0, done: false }])
		await expect(WorkflowSession.start("wf", {}, makeDeps(engine))).rejects.toThrow(/no nextPrompt/)
	})

	it("frameWorkflowStepPrompt appends the per-step attempt_completion instruction", () => {
		const framed = frameWorkflowStepPrompt("Write the test")
		expect(framed).toContain("Write the test")
		expect(framed).toContain("attempt_completion")
		expect(framed).toContain("this step")
	})
})
