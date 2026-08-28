import fs from "fs/promises"
import os from "os"
import path from "path"

import {
	addManifestEntry,
	gcSharedFiles,
	getTaskArtifacts,
	listSharedFiles,
	readManifest,
	storeSharedFile,
} from "../shared-file-store"

const PNG_DATA_URL_1 =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG_DATA_URL_2 =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

describe("shared-file-store", () => {
	let globalStorage: string

	beforeEach(async () => {
		globalStorage = await fs.mkdtemp(path.join(os.tmpdir(), "shared-file-store-test-"))
	})

	afterEach(async () => {
		await fs.rm(globalStorage, { recursive: true, force: true })
	})

	const makeTaskDir = async (taskId: string): Promise<string> => {
		const dir = path.join(globalStorage, "tasks", taskId)
		await fs.mkdir(dir, { recursive: true })
		return dir
	}

	it("storeSharedFile writes content-addressed file and records manifest entry", async () => {
		const taskDir = await makeTaskDir("task-1")
		const info = await storeSharedFile(globalStorage, taskDir, PNG_DATA_URL_1, { source: "user-upload" })

		expect(info.ext).toBe("png")
		expect(info.size).toBeGreaterThan(0)
		await expect(fs.access(info.absPath)).resolves.toBeUndefined()

		const manifest = await readManifest(taskDir)
		expect(manifest.entries).toHaveLength(1)
		expect(manifest.entries[0].hash).toBe(info.hash)
		expect(manifest.entries[0].source).toBe("user-upload")
	})

	it("dedupes identical content across tasks (same hash, one file)", async () => {
		const dir1 = await makeTaskDir("task-1")
		const dir2 = await makeTaskDir("task-2")

		const a = await storeSharedFile(globalStorage, dir1, PNG_DATA_URL_1)
		const b = await storeSharedFile(globalStorage, dir2, PNG_DATA_URL_1)

		expect(a.hash).toBe(b.hash)
		expect(a.absPath).toBe(b.absPath)

		const files = await listSharedFiles(globalStorage)
		expect(files).toHaveLength(1)

		// Both manifests reference it.
		const m1 = await readManifest(dir1)
		const m2 = await readManifest(dir2)
		expect(m1.entries).toHaveLength(1)
		expect(m2.entries).toHaveLength(1)
	})

	it("stores different content as different files", async () => {
		const dir1 = await makeTaskDir("task-1")
		await storeSharedFile(globalStorage, dir1, PNG_DATA_URL_1)
		await storeSharedFile(globalStorage, dir1, PNG_DATA_URL_2)

		const files = await listSharedFiles(globalStorage)
		expect(files).toHaveLength(2)
	})

	it("addManifestEntry is idempotent per hash", async () => {
		const dir1 = await makeTaskDir("task-1")
		await storeSharedFile(globalStorage, dir1, PNG_DATA_URL_1)
		await storeSharedFile(globalStorage, dir1, PNG_DATA_URL_1)

		const manifest = await readManifest(dir1)
		expect(manifest.entries).toHaveLength(1)
	})

	it("gcSharedFiles removes unreferenced files and keeps referenced ones", async () => {
		const dir1 = await makeTaskDir("task-1")
		const dir2 = await makeTaskDir("task-2")
		const dir3 = await makeTaskDir("task-3")

		const shared = await storeSharedFile(globalStorage, dir1, PNG_DATA_URL_1)
		const onlyInDeleted = await storeSharedFile(globalStorage, dir2, PNG_DATA_URL_2)

		// task-3 references nothing.

		// Delete task-1 and task-2: PNG_1 still referenced by... wait, task-1 held it.
		// Set up so PNG_1 is referenced by task-3 too before deletion.
		await addManifestEntry(dir3, {
			hash: shared.hash,
			ext: shared.ext,
			size: shared.size,
			kind: "image",
			source: "test",
			ts: Date.now(),
		})

		const gc = await gcSharedFiles(globalStorage, ["task-1", "task-2"])

		expect(gc.kept).toContain(shared.hash)
		expect(gc.removed).toContain(onlyInDeleted.hash)

		const files = await listSharedFiles(globalStorage)
		expect(files).toHaveLength(1)
		expect(files[0].hash).toBe(shared.hash)
	})

	it("gcSharedFiles removes everything when no remaining task references them", async () => {
		const dir1 = await makeTaskDir("task-1")
		await storeSharedFile(globalStorage, dir1, PNG_DATA_URL_1)

		const gc = await gcSharedFiles(globalStorage, ["task-1"])
		expect(gc.removed).toHaveLength(1)
		expect(await listSharedFiles(globalStorage)).toHaveLength(0)
	})

	it("readManifest returns empty manifest for missing/corrupt file", async () => {
		const dir1 = await makeTaskDir("task-legacy")
		const manifest = await readManifest(dir1)
		expect(manifest.entries).toHaveLength(0)

		await fs.writeFile(path.join(dir1, "manifest.json"), "not json{", "utf8")
		const corrupt = await readManifest(dir1)
		expect(corrupt.entries).toHaveLength(0)
	})

	it("getTaskArtifacts reports manifest entries and legacy images", async () => {
		const dir1 = await makeTaskDir("task-1")
		await storeSharedFile(globalStorage, dir1, PNG_DATA_URL_1)

		// Simulate legacy per-task images.
		const legacyDir = path.join(dir1, "images")
		await fs.mkdir(legacyDir, { recursive: true })
		await fs.writeFile(path.join(legacyDir, "abc.png"), Buffer.from("legacy-bytes"))

		const artifacts = await getTaskArtifacts(globalStorage, dir1)
		expect(artifacts.shared).toHaveLength(1)
		expect(artifacts.legacyImages).toBe(1)
		expect(artifacts.legacyImagesBytes).toBeGreaterThan(0)
	})

	it("getTaskArtifacts handles task with no artifacts", async () => {
		const dir1 = await makeTaskDir("task-empty")
		const artifacts = await getTaskArtifacts(globalStorage, dir1)
		expect(artifacts.shared).toHaveLength(0)
		expect(artifacts.legacyImages).toBe(0)
		expect(artifacts.legacyImagesBytes).toBe(0)
	})
})
