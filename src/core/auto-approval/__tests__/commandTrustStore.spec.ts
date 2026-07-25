import * as fs from "fs/promises"
import os from "os"
import * as path from "path"

import {
	fingerprintCommand,
	isCommandTrusted,
	readTrustedCommands,
	removeTrustedCommand,
	trustCommand,
} from "../commandTrustStore"

describe("project command trust store", () => {
	let cwd: string

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-command-trust-"))
	})

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("trusts only the exact command in the current project", async () => {
		await trustCommand(cwd, "pnpm test")

		expect(await isCommandTrusted(cwd, "pnpm test")).toBe(true)
		expect(await isCommandTrusted(cwd, "pnpm test --runInBand")).toBe(false)
		expect(await isCommandTrusted(`${cwd}-other`, "pnpm test")).toBe(false)
	})

	it("removes a trusted command by its fingerprint", async () => {
		await trustCommand(cwd, "pnpm lint")
		await removeTrustedCommand(cwd, fingerprintCommand(cwd, "pnpm lint"))

		expect(await readTrustedCommands(cwd)).toEqual([])
	})
})
