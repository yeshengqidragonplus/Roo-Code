import type { Node, Edge } from "@xyflow/react"

import { buildSaveGraph } from "../buildSaveGraph"
import type { WorkflowNodeData } from "../WorkflowNodeView"

describe("buildSaveGraph", () => {
	const original = {
		name: "APK 逆向工程标准流程",
		description: "engine routing",
		version: "3.0.0",
		inputs: [{ name: "apkPath", type: "string", required: true }],
		nodes: [{ id: "stale", type: "llm", position: { x: 0, y: 0 }, data: {} }],
		edges: [],
	}

	const editedNodes = [
		{
			id: "n1",
			position: { x: 10, y: 20 },
			data: {
				node: { id: "n1", type: "llm", position: { x: 0, y: 0 }, data: { exec: "soft", prompt: "P" } },
			},
		},
	] as unknown as Node<WorkflowNodeData>[]

	const editedEdges = [
		{ id: "e1", source: "n1", target: "n2", label: "true" },
		{ id: "e2", source: "n2", target: "n3" },
	] as unknown as Edge[]

	it("preserves top-level fields the editor does not model (inputs, version, name)", () => {
		const result = buildSaveGraph(original, editedNodes, editedEdges)
		expect(result.version).toBe("3.0.0")
		expect(result.inputs).toEqual(original.inputs)
		expect(result.name).toBe(original.name)
		expect(result.description).toBe(original.description)
	})

	it("replaces nodes and edges with the edited state (positions from React Flow, branch from label)", () => {
		const result = buildSaveGraph(original, editedNodes, editedEdges)
		expect(result.nodes).toEqual([
			{ id: "n1", type: "llm", position: { x: 10, y: 20 }, data: { exec: "soft", prompt: "P" } },
		])
		expect(result.edges).toEqual([
			{ id: "e1", source: "n1", target: "n2", data: { branch: "true" } },
			{ id: "e2", source: "n2", target: "n3" },
		])
	})
})
