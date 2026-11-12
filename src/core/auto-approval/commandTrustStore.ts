import crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import { isCommandSnapshotUnchanged, type CommandReviewSnapshot } from "./reviewer"

export interface CommandTrustEntry {
	sha256: string
	command: string
	trustedAt: string
	fingerprintVersion?: 2
	commandCwd?: string
	scriptPath?: string
	scriptSha256?: string
}

interface CommandTrustFile {
	version: 1 | 2
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

/** V2 binds trust to the real execution directory and captured script bytes. */
export const fingerprintCommandSnapshot = (projectRoot: string, snapshot: CommandReviewSnapshot) =>
	crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				version: 2,
				kind: "command",
				projectRoot: path.resolve(projectRoot),
				command: snapshot.command,
				cwd: snapshot.cwdRealPath,
				scriptPath: snapshot.scriptPath ?? null,
				scriptSha256: snapshot.sha256 ?? null,
			}),
		)
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
		`${JSON.stringify({ version: 2, entries } satisfies CommandTrustFile, null, "\t")}\n`,
		"utf8",
	)
}

export async function isCommandTrusted(
	cwd: string,
	command: string,
	snapshot?: CommandReviewSnapshot,
): Promise<boolean> {
	if (
		!snapshot ||
		snapshot.requiresHuman ||
		snapshot.command !== command ||
		!(await isCommandSnapshotUnchanged(snapshot))
	)
		return false
	const sha256 = fingerprintCommandSnapshot(cwd, snapshot)
	return (await readTrustedCommands(cwd)).some((entry) => entry.fingerprintVersion === 2 && entry.sha256 === sha256)
}

export async function trustCommand(cwd: string, command: string, snapshot?: CommandReviewSnapshot): Promise<boolean> {
	if (
		!snapshot ||
		snapshot.requiresHuman ||
		snapshot.command !== command ||
		!(await isCommandSnapshotUnchanged(snapshot))
	)
		return false
	const entries = await readTrustedCommands(cwd)
	const sha256 = fingerprintCommandSnapshot(cwd, snapshot)
	if (entries.some((entry) => entry.fingerprintVersion === 2 && entry.sha256 === sha256)) return true
	await writeTrustedCommands(cwd, [
		...entries,
		{
			sha256,
			command,
			trustedAt: new Date().toISOString(),
			fingerprintVersion: 2,
			commandCwd: snapshot.cwdRealPath,
			scriptPath: snapshot.scriptPath,
			scriptSha256: snapshot.sha256,
		},
	])
	return true
}

export async function removeTrustedCommand(cwd: string, sha256: string): Promise<void> {
	await writeTrustedCommands(
		cwd,
		(await readTrustedCommands(cwd)).filter((entry) => entry.sha256 !== sha256),
	)
}
