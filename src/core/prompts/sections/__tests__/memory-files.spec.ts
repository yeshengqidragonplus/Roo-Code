// npx vitest core/prompts/sections/__tests__/memory-files.spec.ts

import fs from "fs/promises"
import os from "os"
import path from "path"

import { loadMemoryFiles, addCustomInstructions } from "../custom-instructions"
import * as rooConfig from "../../../../services/roo-config"

describe("loadMemoryFiles", () => {
	let tmpRoot: string
	let globalRoo: string
	let projectCwd: string

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-memory-"))
		globalRoo = path.join(tmpRoot, "global", ".roo")
		projectCwd = path.join(tmpRoot, "project")
		await fs.mkdir(projectCwd, { recursive: true })

		// Pin directory discovery to our temp dirs (global first, then project-local).
		vi.spyOn(rooConfig, "getRooDirectoriesForCwd").mockReturnValue([globalRoo, path.join(projectCwd, ".roo")])
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(tmpRoot, { recursive: true, force: true })
	})

	async function writeMemory(rooDir: string, filename: string, content: string) {
		const memoryDir = path.join(rooDir, "memory")
		await fs.mkdir(memoryDir, { recursive: true })
		await fs.writeFile(path.join(memoryDir, filename), content, "utf-8")
	}

	it("returns empty string when no .roo/memory directories exist", async () => {
		expect(await loadMemoryFiles(projectCwd)).toBe("")
	})

	it("loads project-local memory and includes a header", async () => {
		await writeMemory(path.join(projectCwd, ".roo"), "auth.md", "Auth uses JWT.")
		const result = await loadMemoryFiles(projectCwd)
		expect(result).toContain("# Project memory from .roo directories:")
		expect(result).toContain("Auth uses JWT.")
	})

	it("merges global and project memory with global first", async () => {
		await writeMemory(globalRoo, "g.md", "GLOBAL_FACT")
		await writeMemory(path.join(projectCwd, ".roo"), "p.md", "PROJECT_FACT")
		const result = await loadMemoryFiles(projectCwd)
		expect(result.indexOf("GLOBAL_FACT")).toBeLessThan(result.indexOf("PROJECT_FACT"))
	})
})

describe("addCustomInstructions — project memory injection", () => {
	let tmpRoot: string
	let projectCwd: string

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-memory-ci-"))
		projectCwd = path.join(tmpRoot, "project")
		await fs.mkdir(path.join(projectCwd, ".roo", "memory"), { recursive: true })
		await fs.writeFile(path.join(projectCwd, ".roo", "memory", "x.md"), "REMEMBERED_FACT", "utf-8")

		vi.spyOn(rooConfig, "getRooDirectoriesForCwd").mockReturnValue([
			path.join(tmpRoot, "global", ".roo"),
			path.join(projectCwd, ".roo"),
		])
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(tmpRoot, { recursive: true, force: true })
	})

	it("injects memory by default", async () => {
		const result = await addCustomInstructions("", "", projectCwd, "code", {})
		expect(result).toContain("REMEMBERED_FACT")
	})

	it("omits memory when useProjectMemory is false", async () => {
		const result = await addCustomInstructions("", "", projectCwd, "code", {
			settings: {
				todoListEnabled: true,
				useAgentRules: true,
				newTaskRequireTodos: false,
				useProjectMemory: false,
			},
		})
		expect(result).not.toContain("REMEMBERED_FACT")
	})
})
