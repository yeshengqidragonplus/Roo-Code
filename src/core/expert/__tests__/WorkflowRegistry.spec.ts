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

	describe("dual-file architecture (load merge / save split)", () => {
		it("does not discover .config.json companions as workflows", async () => {
			await writeWorkflow(projectDir, "wf.json", { name: "wf", nodes: [], edges: [] })
			await writeWorkflow(projectDir, "wf.config.json", { n1: { prompt: "p" } })
			const warn = vi.fn()
			const reg = registry(warn)
			await reg.discover()

			expect(reg.list().map((w) => w.id)).toEqual(["wf"])
			expect(warn).not.toHaveBeenCalled()
		})

		it("merges config into node data, keeping non-architecture fields from the architecture file", async () => {
			await writeWorkflow(projectDir, "wf.json", {
				name: "wf",
				nodes: [
					{
						id: "n1",
						type: "llm",
						position: { x: 0, y: 0 },
						data: { exec: "soft", customData: {}, label: "Step 1" },
					},
				],
				edges: [],
			})
			await writeWorkflow(projectDir, "wf.config.json", {
				n1: { prompt: "do it", outputSchema: { type: "object" }, exec: "hard" },
			})
			const reg = registry()
			await reg.discover()

			const graph = (await reg.load("wf")) as { nodes: Array<{ data: Record<string, unknown> }> }
			expect(graph.nodes[0].data).toEqual({
				exec: "soft", // architecture field wins over config's "hard"
				customData: {},
				label: "Step 1", // non-architecture field survives the merge
				prompt: "do it",
				outputSchema: { type: "object" },
			})
		})

		it("skips merging for legacy nodes that already carry content fields", async () => {
			await writeWorkflow(projectDir, "wf.json", {
				name: "wf",
				nodes: [{ id: "n1", type: "llm", position: { x: 0, y: 0 }, data: { exec: "soft", prompt: "legacy" } }],
				edges: [],
			})
			await writeWorkflow(projectDir, "wf.config.json", { n1: { prompt: "from config" } })
			const reg = registry()
			await reg.discover()

			const graph = (await reg.load("wf")) as { nodes: Array<{ data: Record<string, unknown> }> }
			expect(graph.nodes[0].data.prompt).toBe("legacy")
		})

		it("save splits node data into architecture + config files and preserves top-level fields", async () => {
			const graph = {
				name: "wf",
				description: "d",
				version: "3.0.0",
				inputs: [{ name: "apkPath", type: "string", required: true }],
				nodes: [
					{
						id: "n1",
						type: "llm",
						position: { x: 0, y: 0 },
						data: { exec: "soft", prompt: "P", outputSchema: { type: "object" } },
					},
					{
						id: "n2",
						type: "condition",
						position: { x: 100, y: 0 },
						data: { expression: "{{n1.output.ok}}" },
					},
				],
				edges: [{ id: "e1", source: "n1", target: "n2" }],
			}
			const reg = registry()
			await reg.save("wf", projectDir, graph)

			const arch = JSON.parse(await fs.readFile(path.join(projectDir, "wf.json"), "utf8"))
			const config = JSON.parse(await fs.readFile(path.join(projectDir, "wf.config.json"), "utf8"))

			// Architecture file: topology + architecture fields only, top-level preserved
			expect(arch.version).toBe("3.0.0")
			expect(arch.inputs).toEqual(graph.inputs)
			expect(arch.nodes[0].data).toEqual({ exec: "soft" })
			expect(arch.nodes[1].data).toEqual({ expression: "{{n1.output.ok}}" })
			// Config file: content fields only, keyed by node id
			expect(config).toEqual({ n1: { prompt: "P", outputSchema: { type: "object" } } })
		})

		it("round-trips: save → load returns the original graph, and is idempotent", async () => {
			const original = {
				name: "APK 逆向工程标准流程",
				description: "engine routing",
				version: "3.0.0",
				inputs: [{ name: "apkPath", type: "string", required: true }],
				nodes: [
					{
						id: "env-check",
						type: "llm",
						position: { x: 0, y: 120 },
						data: { exec: "soft", prompt: "环境检查……", outputSchema: { type: "object" } },
					},
					{
						id: "engine-identify",
						type: "condition",
						position: { x: 240, y: 120 },
						data: { expression: "{{env-check.output.engine}}" },
					},
					{
						id: "decompile",
						type: "tool",
						position: { x: 480, y: 120 },
						data: { exec: "hard", toolName: "mcp__ida__decompile", params: { all: true } },
					},
				],
				edges: [
					{ id: "e1", source: "env-check", target: "engine-identify" },
					{ id: "e2", source: "engine-identify", target: "decompile", data: { branch: "true" } },
				],
			}

			const reg = registry()
			await reg.save("apk-rt", projectDir, original)
			await reg.discover()

			const loaded1 = await reg.load("apk-rt")
			expect(loaded1).toEqual(original)

			await reg.save("apk-rt", projectDir, loaded1 as Record<string, unknown>)
			await reg.discover()
			const loaded2 = await reg.load("apk-rt")
			expect(loaded2).toEqual(loaded1)
		})
	})
})
