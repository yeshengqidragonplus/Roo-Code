import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, rmdir, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { runIsolationProbe } from "./isolation-probe.mjs"

async function fixture(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), "qcode-isolation-test-"))
	const workspace = path.join(root, "project")
	const outsideDirectory = path.join(root, "outside")
	const outsideMarker = path.join(outsideDirectory, "marker.txt")
	t.after(async () => {
		await unlink(outsideMarker)
		await rmdir(outsideDirectory)
		await rmdir(workspace)
		await rmdir(root)
	})
	await mkdir(workspace)
	await mkdir(outsideDirectory)
	await writeFile(outsideMarker, "not a secret")
	return { workspace, outsideDirectory, outsideMarker, expectedUser: os.userInfo().username }
}

test("detects when the test user can read and write outside the project", async (t) => {
	const options = await fixture(t)
	const result = await runIsolationProbe(options)
	assert.equal(result.checks.identity.status, "pass")
	assert.equal(result.checks.childIdentity.status, "pass")
	assert.equal(result.checks.projectWrite.status, "pass")
	assert.equal(result.checks.outsideRead.status, "fail")
	assert.equal(result.checks.outsideWrite.status, "fail")
	assert.equal(result.passed, false)
	assert.deepEqual(await readdir(options.workspace), [])
	assert.deepEqual(await readdir(options.outsideDirectory), ["marker.txt"])
})

test("does not confuse a missing marker with a permission denial", async (t) => {
	const options = await fixture(t)
	options.outsideMarker = path.join(options.outsideDirectory, "missing.txt")
	const result = await runIsolationProbe(options)
	assert.equal(result.checks.outsideRead.status, "fail")
	assert.equal(result.checks.outsideRead.observed, "error")
	assert.equal(result.passed, false)
})

test("rejects overlapping paths and reports an unexpected user", async (t) => {
	const options = await fixture(t)
	await assert.rejects(runIsolationProbe({ ...options, outsideDirectory: options.workspace }), /separate/)
	const result = await runIsolationProbe({ ...options, expectedUser: `${options.expectedUser}-other` })
	assert.equal(result.checks.identity.status, "fail")
})
