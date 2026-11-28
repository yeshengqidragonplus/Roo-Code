import path from "path"
import fs from "fs/promises"

import { isUnprotectedProjectPath } from "../projectPath"

vi.mock("fs/promises", () => ({ default: { realpath: vi.fn(), lstat: vi.fn() } }))

describe("automatic approval project path containment", () => {
	const root = path.resolve("test-project")
	const outside = path.resolve("other-project", "secret")
	beforeEach(() => {
		vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		vi.mocked(fs.realpath).mockImplementation(async (value) => {
			const input = String(value)
			if (input === path.join(root, "link")) return outside
			if (input.endsWith("missing")) throw Object.assign(new Error("missing"), { code: "ENOENT" })
			return input
		})
	})
	it("allows an ordinary project file and a missing final component", async () => {
		expect(await isUnprotectedProjectPath(root, "file.txt", () => false)).toBe(true)
		expect(await isUnprotectedProjectPath(root, "missing", () => false)).toBe(true)
	})
	it("requires approval for traversal, symlinks outside, protected paths or failed resolution", async () => {
		expect(await isUnprotectedProjectPath(root, "../other-project/secret", () => false)).toBe(false)
		expect(await isUnprotectedProjectPath(root, "link", () => false)).toBe(false)
		expect(await isUnprotectedProjectPath(root, "AGENTS.md", (name) => name === "AGENTS.md")).toBe(false)
		vi.mocked(fs.realpath).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
		expect(await isUnprotectedProjectPath(root, "file.txt", () => false)).toBe(false)
	})
	it("does not treat a dangling symlink as a new file", async () => {
		vi.mocked(fs.lstat).mockResolvedValue({} as never)
		expect(await isUnprotectedProjectPath(root, "missing", () => false)).toBe(false)
	})
})
