import * as fs from "fs"

import { createDynamicImportProvider } from "../WorkflowEngineProvider"
import { WorkflowExpertRunner, type WorkflowExpertRunnerDeps } from "../WorkflowExpertRunner"

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
		{ id: "read", type: "tool", position: { x: 0, y: 0 }, data: { toolName: "readIssue", params: { q: "{{inputs.issueText}}" }, exec: "hard" } },
		{ id: "cls", type: "llm", position: { x: 0, y: 1 }, data: { prompt: "bug or feature: {{read.output}}", outputSchema: { type: "object", properties: { label: { type: "string" } } } } },
		{ id: "cond", type: "condition", position: { x: 0, y: 2 }, data: { expression: '{{cls.output.label}} === "bug"' } },
		{ id: "bug", type: "expert", position: { x: 0, y: 3 }, data: { expertId: "fixer", subtaskPrompt: "fix: {{inputs.issueText}}", exec: "hard" } },
		{ id: "feat", type: "tool", position: { x: 1, y: 3 }, data: { toolName: "createFeatureRequest", params: { text: "x" }, exec: "hard" } },
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
})
