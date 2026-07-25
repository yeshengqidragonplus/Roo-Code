import crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

export interface CommandTrustEntry {
	sha256: string
	command: string
	trustedAt: string
}

interface CommandTrustFile {
	version: 1
	entries: CommandTrustEntry[]
}

const trustFileName = "command-trust.json"

export const getCommandTrustFilePath = (cwd: string) => path.join(cwd, ".roo", trustFileName)

/** The project path is included so a trust decision cannot leak into another project. */
export const fingerprintCommand = (cwd: string, command: string) =>
	crypto
		.createHash("sha256")
		.update(JSON.stringify({ version: 1, kind: "command", cwd: path.resolve(cwd), command }))
		.digest("hex")

export async function readTrustedCommands(cwd: string): Promise<CommandTrustEntry[]> {
	try {
		const raw = await fs.readFile(getCommandTrustFilePath(cwd), "utf8")
		const parsed = JSON.parse(raw) as Partial<CommandTrustFile>
		return Array.isArray(parsed.entries)
			? parsed.entries.filter(
					(entry): entry is CommandTrustEntry =>
						typeof entry?.sha256 === "string" &&
						typeof entry.command === "string" &&
						typeof entry.trustedAt === "string",
				)
			: []
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		console.warn("Failed to read project command trust list", error)
		return []
	}
}

async function writeTrustedCommands(cwd: string, entries: CommandTrustEntry[]): Promise<void> {
	const filePath = getCommandTrustFilePath(cwd)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(
		filePath,
		`${JSON.stringify({ version: 1, entries } satisfies CommandTrustFile, null, "\t")}\n`,
		"utf8",
	)
}

export async function isCommandTrusted(cwd: string, command: string): Promise<boolean> {
	const sha256 = fingerprintCommand(cwd, command)
	return (await readTrustedCommands(cwd)).some((entry) => entry.sha256 === sha256)
}

export async function trustCommand(cwd: string, command: string): Promise<void> {
	const entries = await readTrustedCommands(cwd)
	const sha256 = fingerprintCommand(cwd, command)
	if (entries.some((entry) => entry.sha256 === sha256)) return
	await writeTrustedCommands(cwd, [...entries, { sha256, command, trustedAt: new Date().toISOString() }])
}

export async function removeTrustedCommand(cwd: string, sha256: string): Promise<void> {
	await writeTrustedCommands(
		cwd,
		(await readTrustedCommands(cwd)).filter((entry) => entry.sha256 !== sha256),
	)
}
