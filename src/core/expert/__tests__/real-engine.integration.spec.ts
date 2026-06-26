import * as fs from "fs"

import { createDynamicImportProvider } from "../WorkflowEngineProvider"
import { WorkflowExpertRunner, type WorkflowExpertRunnerDeps } from "../WorkflowExpertRunner"
import { WorkflowSession, type WorkflowSessionDeps } from "../WorkflowSession"

// Local integration test against the real AIWorkflow engine build artifact.
// Skips when the artifact isn't present (e.g. CI / machines without the sibling
// repo built), so it never breaks the suite — but locks the contract locally.
const ARTIFACT = "/Volumes/workspace/GitHubTest/AIWorkflow/dist-engine/engine.mjs"
const haveArtifact = fs.existsSync(ARTIFACT)

const SAMPLE = {
	name: "triage-flow",
	description: "triage flow",
	version: "1.0.0",
	inputs: [{ name: "issueText", type: "string", required: true }],
	nodes: [
		{
			id: "read",
			type: "tool",
			position: { x: 0, y: 0 },
			data: { toolName: "readIssue", params: { q: "{{inputs.issueText}}" }, exec: "hard" },
		},
		{
			id: "cls",
			type: "llm",
			position: { x: 0, y: 1 },
			data: {
				prompt: "bug or feature: {{read.output}}",
				outputSchema: { type: "object", properties: { label: { type: "string" } } },
			},
		},
		{
			id: "cond",
			type: "condition",
			position: { x: 0, y: 2 },
			data: { expression: '{{cls.output.label}} === "bug"' },
		},
		{
			id: "bug",
			type: "expert",
			position: { x: 0, y: 3 },
			data: { expertId: "fixer", subtaskPrompt: "fix: {{inputs.issueText}}", exec: "hard" },
		},
		{
			id: "feat",
			type: "tool",
			position: { x: 1, y: 3 },
			data: { toolName: "createFeatureRequest", params: { text: "x" }, exec: "hard" },
		},
	],
	edges: [
		{ id: "e1", source: "read", target: "cls" },
		{ id: "e2", source: "cls", target: "cond" },
		{ id: "e3", source: "cond", target: "bug", data: { branch: "true" } },
		{ id: "e4", source: "cond", target: "feat", data: { branch: "false" } },
	],
}

describe.skipIf(!haveArtifact)("real AIWorkflow engine integration", () => {
	it("loads the built artifact via the dynamic-import provider and drives the runner", async () => {
		const provider = createDynamicImportProvider(ARTIFACT)
		const engine = await provider(SAMPLE)

		const trace: string[] = []
		const deps: WorkflowExpertRunnerDeps = {
			runLlmTurn: async (prompt) => {
				trace.push(`llm:${prompt.slice(0, 20)}`)
				return JSON.stringify({ label: "bug" }) // outputSchema → parsed → bug branch
			},
			executeAction: async (action) => {
				trace.push(`action:${action.type}`)
				return action.type === "delegate" ? `delegated ${action.expert}` : `${(action as any).name} done`
			},
			persistState: async () => {},
		}

		const result = await new WorkflowExpertRunner(engine, deps).run({ issueText: "保存时崩溃" })

		// tool(read) → llm(cls) → condition(bug branch) → delegate(fixer).
		// The prompt's {{read.output}} is resolved by the engine to the tool result.
		expect(trace).toEqual(["action:tool", "llm:bug or feature: read", "action:delegate"])
		expect(result).toContain("delegated fixer")
	})

	// Phase 2: drive the host-side WorkflowSession (soft + delegate) against the real
	// engine through a soft → soft → delegate → soft → done flow, proving the engine
	// surfaces a delegate action as turn.delegate and that advancing past it (with the
	// sub-expert summary as lastOutput) continues to the terminal node.
	it("WorkflowSession surfaces a real-engine delegate and advances past it", async () => {
		const PLAN_WRITE = {
			name: "explain-plan-write",
			description: "soft → soft → delegate → soft",
			version: "1.0.0",
			inputs: [{ name: "task", type: "string", required: true }],
			nodes: [
				{ id: "restate", type: "llm", position: { x: 0, y: 0 }, data: { prompt: "restate: {{inputs.task}}" } },
				{ id: "plan", type: "llm", position: { x: 0, y: 1 }, data: { prompt: "plan: {{restate.output}}" } },
				{
					id: "write",
					type: "expert",
					position: { x: 0, y: 2 },
					data: { mode: "code", exec: "hard", subtaskPrompt: "write: {{plan.output}}" },
				},
				{ id: "confirm", type: "llm", position: { x: 0, y: 3 }, data: { prompt: "confirm: {{write.output}}" } },
			],
			edges: [
				{ id: "e1", source: "restate", target: "plan" },
				{ id: "e2", source: "plan", target: "write" },
				{ id: "e3", source: "write", target: "confirm" },
			],
		}

		const persisted: unknown[] = []
		const deps: WorkflowSessionDeps = {
			createEngine: async () => createDynamicImportProvider(ARTIFACT)(PLAN_WRITE),
			persist: async (_id, state) => {
				persisted.push(state)
			},
		}

		const { session, turn: t0 } = await WorkflowSession.start("explain-plan-write", { task: "ship the docs" }, deps)
		expect(t0.prompt).toContain("restate: ship the docs")

		const t1 = await session.advance("the restated goal")
		expect(t1.prompt).toContain("plan: the restated goal")

		// plan → write is a hard `expert` node: the real engine returns a delegate action.
		const t2 = await session.advance("the plan")
		expect(t2.delegate).toEqual({ expert: "code", goal: "write: the plan" })
		expect(t2.prompt).toBeUndefined()

		// Advance with the sub-expert's summary as lastOutput → terminal confirm node.
		const t3 = await session.advance("wrote docs/output.md")
		expect(t3.prompt).toContain("confirm: wrote docs/output.md")

		const t4 = await session.advance("looks complete")
		expect(t4.done).toBe(true)

		// Every step persisted engine state (start + 4 advances).
		expect(persisted.length).toBe(5)
	})
})
