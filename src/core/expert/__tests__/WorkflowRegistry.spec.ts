import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { WorkflowRegistry } from "../WorkflowRegistry"

async function writeWorkflow(dir: string, filename: string, body: object | string): Promise<void> {
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(path.join(dir, filename), typeof body === "string" ? body : JSON.stringify(body))
}

describe("WorkflowRegistry", () => {
	let root: string
	let globalDir: string
	let projectDir: string

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "wfreg-"))
		globalDir = path.join(root, "global")
		projectDir = path.join(root, "project")
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	function registry(warn?: (m: string) => void) {
		return new WorkflowRegistry(
			[
				{ dir: globalDir, source: "global" },
				{ dir: projectDir, source: "project" },
			],
			warn,
		)
	}

	it("discovers workflows by filename id and reads display name/description", async () => {
		await writeWorkflow(globalDir, "release-flow.json", {
			name: "Release Flow",
			description: "ship it",
			nodes: [],
			edges: [],
		})
		const reg = registry()
		await reg.discover()

		const list = reg.list()
		expect(list).toHaveLength(1)
		expect(list[0]).toMatchObject({
			id: "release-flow",
			name: "Release Flow",
			description: "ship it",
			source: "global",
		})
	})

	it("falls back to the id when the JSON has no name", async () => {
		await writeWorkflow(projectDir, "code-review.json", { nodes: [], edges: [] })
		const reg = registry()
		await reg.discover()
		expect(reg.get("code-review")).toMatchObject({ id: "code-review", name: "code-review" })
	})

	it("lets a project workflow override a global one with the same id", async () => {
		await writeWorkflow(globalDir, "dup.json", { name: "global one", nodes: [], edges: [] })
		await writeWorkflow(projectDir, "dup.json", { name: "project one", nodes: [], edges: [] })
		const reg = registry()
		await reg.discover()

		expect(reg.list()).toHaveLength(1)
		expect(reg.get("dup")).toMatchObject({ name: "project one", source: "project" })
	})

	it("skips files with an invalid id slug and warns", async () => {
		await writeWorkflow(globalDir, "Bad_Name.json", { nodes: [], edges: [] })
		const warn = vi.fn()
		const reg = registry(warn)
		await reg.discover()

		expect(reg.list()).toHaveLength(0)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid id"))
	})

	it("skips invalid JSON and warns, ignores non-json files", async () => {
		await writeWorkflow(globalDir, "broken.json", "{ not json")
		await writeWorkflow(globalDir, "notes.txt", "ignored")
		const warn = vi.fn()
		const reg = registry(warn)
		await reg.discover()

		expect(reg.list()).toHaveLength(0)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"))
	})

	it("loads and parses the full workflow graph by id", async () => {
		const graph = { name: "wf", description: "", nodes: [{ id: "n1" }], edges: [] }
		await writeWorkflow(projectDir, "wf.json", graph)
		const reg = registry()
		await reg.discover()

		await expect(reg.load("wf")).resolves.toEqual(graph)
		await expect(reg.load("missing")).rejects.toThrow(/not found/)
	})

	it("treats absent directories as empty (no throw)", async () => {
		const reg = registry()
		await expect(reg.discover()).resolves.toBeUndefined()
		expect(reg.list()).toEqual([])
	})
})
