// Diagnostic only: this does not launch an isolated process or certify isolation.
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { open, realpath, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

const execFileAsync = promisify(execFile)

function isWithin(parent, child) {
	const relative = path.relative(parent, child)
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function probeWrite(directory) {
	const filename = path.join(directory, `.qcode-isolation-probe-${randomUUID()}`)
	let file
	let created = false
	try {
		file = await open(filename, "wx", 0o600)
		created = true
		await file.writeFile("qcode isolation probe\n")
		await file.close()
		file = undefined
		file = await open(filename, "r")
		await file.read(Buffer.alloc(1), 0, 1, 0)
		return { status: "allowed" }
	} catch (error) {
		return { status: error?.code === "EACCES" || error?.code === "EPERM" ? "denied" : "error", code: error?.code }
	} finally {
		await file?.close()
		if (created) await unlink(filename)
	}
}

async function probeRead(filename) {
	let file
	try {
		file = await open(filename, "r")
		await file.read(Buffer.alloc(1), 0, 1, 0)
		return { status: "allowed" }
	} catch (error) {
		return { status: error?.code === "EACCES" || error?.code === "EPERM" ? "denied" : "error", code: error?.code }
	} finally {
		await file?.close()
	}
}

/** Probe specific test paths; a successful result is not proof of containment. */
export async function runIsolationProbe({ workspace, outsideDirectory, outsideMarker, expectedUser }) {
	if (!workspace || !outsideDirectory || !outsideMarker || !expectedUser) {
		throw new Error("workspace, outsideDirectory, outsideMarker and expectedUser are required")
	}
	const [project, outside] = await Promise.all([realpath(workspace), realpath(outsideDirectory)])
	const marker = path.resolve(outsideMarker)
	if (isWithin(project, outside) || isWithin(outside, project) || !isWithin(outside, marker)) {
		throw new Error("The outside directory must be separate from the workspace, and the marker must be inside it")
	}
	const identity = os.userInfo().username
	const expectedIdentity = process.platform === "win32" ? expectedUser.toLowerCase() : expectedUser
	const actualIdentity = process.platform === "win32" ? identity.toLowerCase() : identity
	const { stdout } = await execFileAsync(
		process.execPath,
		["-e", "process.stdout.write(require('node:os').userInfo().username)"],
		{
			timeout: 10000,
			windowsHide: true,
		},
	)
	const [projectWrite, outsideRead, outsideWrite] = await Promise.all([
		probeWrite(project),
		probeRead(marker),
		probeWrite(outside),
	])
	const checks = {
		identity: { status: actualIdentity === expectedIdentity ? "pass" : "fail" },
		childIdentity: { status: stdout === identity ? "pass" : "fail" },
		projectWrite: {
			status: projectWrite.status === "allowed" ? "pass" : "fail",
			observed: projectWrite.status,
			code: projectWrite.code,
		},
		outsideRead: {
			status: outsideRead.status === "denied" ? "pass" : "fail",
			observed: outsideRead.status,
			code: outsideRead.code,
		},
		outsideWrite: {
			status: outsideWrite.status === "denied" ? "pass" : "fail",
			observed: outsideWrite.status,
			code: outsideWrite.code,
		},
	}
	return { identity, checks, passed: Object.values(checks).every((check) => check.status === "pass") }
}

async function main() {
	const [workspace, outsideDirectory, outsideMarker, expectedUser] = process.argv.slice(2)
	try {
		const result = await runIsolationProbe({ workspace, outsideDirectory, outsideMarker, expectedUser })
		console.log(
			JSON.stringify(
				{ ...result, warning: "Diagnostic only; not proof of isolation or force-push prevention." },
				null,
				2,
			),
		)
		process.exitCode = result.passed ? 0 : 1
	} catch (error) {
		console.error(`Isolation probe failed: ${error.message}`)
		process.exitCode = 1
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await main()
}
