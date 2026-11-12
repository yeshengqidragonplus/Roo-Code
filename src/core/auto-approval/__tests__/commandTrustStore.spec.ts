import * as fs from "fs/promises"
import os from "os"
import * as path from "path"

import {
	fingerprintCommand,
	fingerprintCommandSnapshot,
	isCommandTrusted,
	readTrustedCommands,
	removeTrustedCommand,
	trustCommand,
} from "../commandTrustStore"
import { prepareCommandReview } from "../reviewer"

describe("project command trust store", () => {
	let cwd: string

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-command-trust-"))
	})

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("binds trust to script content and actual working directory", async () => {
		await fs.writeFile(path.join(cwd, "script.py"), "print(1)")
		await fs.mkdir(path.join(cwd, "other"))
		await fs.writeFile(path.join(cwd, "other", "script.py"), "print(1)")
		const command = "python script.py"
		const snapshot = (await prepareCommandReview(command, cwd, cwd))!
		expect(await trustCommand(cwd, command, snapshot)).toBe(true)
		expect(await isCommandTrusted(cwd, command, snapshot)).toBe(true)
		const other = (await prepareCommandReview(command, path.join(cwd, "other"), cwd))!
		expect(await isCommandTrusted(cwd, command, other)).toBe(false)
		await fs.writeFile(path.join(cwd, "script.py"), "print(2)")
		expect(await isCommandTrusted(cwd, command, snapshot)).toBe(false)
		const changed = await prepareCommandReview(command, cwd, cwd)
		expect(await isCommandTrusted(cwd, command, changed)).toBe(false)
		expect(await isCommandTrusted(cwd, "other", snapshot)).toBe(false)
	})

	it("removes a trusted command by its fingerprint", async () => {
		const command = "python -c 'print(42)'"
		const snapshot = (await prepareCommandReview(command, cwd, cwd))!
		await trustCommand(cwd, command, snapshot)
		await removeTrustedCommand(cwd, fingerprintCommandSnapshot(cwd, snapshot))

		expect(await readTrustedCommands(cwd)).toEqual([])
	})

	it("retains but never honors legacy command-only trust; unsupported commands cannot be permanently trusted", async () => {
		await fs.mkdir(path.join(cwd, ".roo"))
		const command = "python -c 'print(42)'"
		await fs.writeFile(
			path.join(cwd, ".roo", "command-trust.json"),
			JSON.stringify({
				version: 1,
				entries: [{ command, sha256: fingerprintCommand(cwd, command), trustedAt: new Date().toISOString() }],
			}),
		)
		const snapshot = await prepareCommandReview(command, cwd, cwd)
		expect(await isCommandTrusted(cwd, command, snapshot)).toBe(false)
		expect(await readTrustedCommands(cwd)).toHaveLength(1)
		expect(await trustCommand(cwd, "npm test")).toBe(false)
		await fs.writeFile(path.join(cwd, "dependent.py"), "import os\nprint(1)")
		const dependent = await prepareCommandReview("python dependent.py", cwd, cwd)
		expect(dependent?.requiresHuman).toBe(true)
		expect(await trustCommand(cwd, "python dependent.py", dependent)).toBe(false)
	})
})
