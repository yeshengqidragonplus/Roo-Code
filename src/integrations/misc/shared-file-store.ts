/**
 * @fileoverview Content-addressed shared file store with per-task manifests.
 *
 * Design (2026-08-28):
 * - Shared content lives once under `<globalStorage>/shared-files/<sha256>.<ext>`
 *   (cross-task dedup; sha256 content addressing, same scheme as image-store).
 * - Each task keeps a manifest at `<taskDir>/manifest.json` listing the artifacts
 *   it references. The manifest lives INSIDE the task dir so it dies with the
 *   task — no orphan manifests, ever.
 * - Deletion is lazy-GC: when a task is deleted, read its manifest, then for each
 *   hash check whether any OTHER task's manifest still references it. Only
 *   unreferenced files are removed from the shared store. No reference counters,
 *   no consistency burden.
 * - Lookup is two-tier: within a session read its manifest; across sessions scan
 *   all manifests (or list the shared dir).
 *
 * Migration: legacy tasks keep their per-task `<taskDir>/images/` untouched.
 * New artifacts go to the shared store; old refs (`roo-image-ref:`) keep working
 * via the existing image-store path.
 */

import fs from "fs/promises"
import * as path from "path"
import * as crypto from "crypto"

/** Directory name under globalStorage for the shared content library. */
export const SHARED_FILES_DIR = "shared-files"

/** Manifest file name inside a task directory. */
export const MANIFEST_FILE = "manifest.json"

const MIME_TO_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
}

/** One artifact entry in a task manifest. */
export interface ManifestEntry {
	/** sha256 hex of the content (also the shared-store filename stem). */
	hash: string
	/** File extension (without dot). */
	ext: string
	/** Byte size. */
	size: number
	/** Artifact kind. */
	kind: "image" | "file"
	/** Where it came from (e.g. "user-upload", "tool-output", "web-researcher"). */
	source: string
	/** Epoch ms when the task stored it. */
	ts: number
}

/** A task manifest: the durable per-session artifact list. */
export interface TaskManifest {
	version: 1
	/** taskId this manifest belongs to (redundant but aids debugging). */
	taskId: string
	entries: ManifestEntry[]
}

/** Summary of a shared file, as surfaced to the webview. */
export interface SharedFileInfo {
	hash: string
	ext: string
	size: number
	kind: string
	/** Absolute path of the shared file. */
	absPath: string
}

/** Result of a GC pass for one deleted task. */
export interface GcResult {
	/** Hashes that were removed from the shared store. */
	removed: string[]
	/** Hashes kept because other tasks still reference them. */
	kept: string[]
}

/** Parse a `data:<mime>;base64,<data>` URI (same rules as image-store). */
function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
	if (!dataUrl.startsWith("data:")) {
		return null
	}
	const commaIdx = dataUrl.indexOf(",")
	if (commaIdx === -1) {
		return null
	}
	const header = dataUrl.slice(5, commaIdx)
	const base64 = dataUrl.slice(commaIdx + 1)
	const mimeType = header.split(";")[0] || "image/png"
	return { mimeType, base64 }
}

/** Absolute path of the shared-files directory. */
export function sharedFilesDirPath(globalStoragePath: string): string {
	return path.join(globalStoragePath, SHARED_FILES_DIR)
}

/** Absolute path of a task's manifest file. */
export function manifestPath(taskDir: string): string {
	return path.join(taskDir, MANIFEST_FILE)
}

/** Read a task manifest; missing file → empty manifest. */
export async function readManifest(taskDir: string): Promise<TaskManifest> {
	try {
		const raw = await fs.readFile(manifestPath(taskDir), "utf8")
		const parsed = JSON.parse(raw) as TaskManifest
		if (parsed && Array.isArray(parsed.entries)) {
			return parsed
		}
	} catch {
		// Missing or corrupt manifest → treat as empty (legacy tasks).
	}
	return { version: 1, taskId: path.basename(taskDir), entries: [] }
}

/** Write a task manifest atomically-ish (single write; manifest is small). */
export async function writeManifest(taskDir: string, manifest: TaskManifest): Promise<void> {
	await fs.mkdir(taskDir, { recursive: true })
	await fs.writeFile(manifestPath(taskDir), JSON.stringify(manifest, null, "\t"), "utf8")
}

/** Append an entry to a task manifest (idempotent per hash). */
export async function addManifestEntry(taskDir: string, entry: ManifestEntry): Promise<TaskManifest> {
	const manifest = await readManifest(taskDir)
	if (!manifest.entries.some((e) => e.hash === entry.hash)) {
		manifest.entries.push(entry)
		await writeManifest(taskDir, manifest)
	}
	return manifest
}

/**
 * Store a base64 data URI into the shared store and record it in the task manifest.
 * Returns the shared filename (`<sha256>.<ext>`). Content-addressed: identical
 * content dedupes to the same file across ALL tasks.
 */
export async function storeSharedFile(
	globalStoragePath: string,
	taskDir: string,
	dataUrl: string,
	options?: { kind?: "image" | "file"; source?: string },
): Promise<SharedFileInfo> {
	const parsed = parseDataUrl(dataUrl)
	if (!parsed) {
		throw new Error("storeSharedFile expects a base64 data URI")
	}
	const buffer = Buffer.from(parsed.base64, "base64")
	const hash = crypto.createHash("sha256").update(buffer).digest("hex")
	const ext = MIME_TO_EXT[parsed.mimeType.toLowerCase()] ?? "png"
	const filename = `${hash}.${ext}`
	const dir = sharedFilesDirPath(globalStoragePath)
	const absPath = path.join(dir, filename)

	try {
		await fs.access(absPath)
	} catch {
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(absPath, buffer)
	}

	await addManifestEntry(taskDir, {
		hash,
		ext,
		size: buffer.length,
		kind: options?.kind ?? "image",
		source: options?.source ?? "user-upload",
		ts: Date.now(),
	})

	return { hash, ext, size: buffer.length, kind: options?.kind ?? "image", absPath }
}

/** List all files in the shared store (cross-session view). */
export async function listSharedFiles(globalStoragePath: string): Promise<SharedFileInfo[]> {
	const dir = sharedFilesDirPath(globalStoragePath)
	let names: string[]
	try {
		names = await fs.readdir(dir)
	} catch {
		return []
	}
	const infos: SharedFileInfo[] = []
	for (const name of names) {
		try {
			const absPath = path.join(dir, name)
			const stat = await fs.stat(absPath)
			if (!stat.isFile()) {
				continue
			}
			const dot = name.lastIndexOf(".")
			infos.push({
				hash: dot > 0 ? name.slice(0, dot) : name,
				ext: dot > 0 ? name.slice(dot + 1) : "",
				size: stat.size,
				kind: "image",
				absPath,
			})
		} catch {
			// File vanished between readdir and stat — skip.
		}
	}
	return infos
}

/**
 * Collect the set of hashes referenced by every task manifest EXCEPT the given
 * excluded task IDs. Scans the manifest.json inside each directory under
 * `<globalStorage>/tasks/`.
 */
export async function collectReferencedHashes(
	globalStoragePath: string,
	excludeTaskIds: string[],
): Promise<Set<string>> {
	const referenced = new Set<string>()
	const tasksRoot = path.join(globalStoragePath, "tasks")
	let taskDirs: string[]
	try {
		taskDirs = await fs.readdir(tasksRoot, { withFileTypes: true }).then((entries) =>
			entries.filter((e) => e.isDirectory()).map((e) => e.name),
		)
	} catch {
		return referenced
	}
	const excluded = new Set(excludeTaskIds)
	for (const dirName of taskDirs) {
		if (excluded.has(dirName)) {
			continue
		}
		const manifest = await readManifest(path.join(tasksRoot, dirName))
		for (const entry of manifest.entries) {
			referenced.add(entry.hash)
		}
	}
	return referenced
}

/**
 * Lazy GC after deleting tasks: remove shared files whose hashes are no longer
 * referenced by any remaining task manifest. Returns what was removed/kept.
 */
export async function gcSharedFiles(
	globalStoragePath: string,
	deletedTaskIds: string[],
): Promise<GcResult> {
	const referenced = await collectReferencedHashes(globalStoragePath, deletedTaskIds)
	const dir = sharedFilesDirPath(globalStoragePath)
	const result: GcResult = { removed: [], kept: [] }
	let names: string[]
	try {
		names = await fs.readdir(dir)
	} catch {
		return result
	}
	for (const name of names) {
		const dot = name.lastIndexOf(".")
		const hash = dot > 0 ? name.slice(0, dot) : name
		if (referenced.has(hash)) {
			result.kept.push(hash)
			continue
		}
		try {
			await fs.rm(path.join(dir, name), { force: true })
			result.removed.push(hash)
		} catch {
			// Best-effort; leave the file for a later GC pass.
		}
	}
	return result
}

/**
 * Build the "associated artifacts" view for a task (used by the delete
 * confirmation UI): manifest entries plus legacy per-task images.
 */
export async function getTaskArtifacts(
	globalStoragePath: string,
	taskDir: string,
): Promise<{ shared: ManifestEntry[]; legacyImages: number; legacyImagesBytes: number }> {
	const manifest = await readManifest(taskDir)
	let legacyImages = 0
	let legacyImagesBytes = 0
	try {
		const legacyDir = path.join(taskDir, "images")
		const names = await fs.readdir(legacyDir)
		for (const name of names) {
			try {
				const stat = await fs.stat(path.join(legacyDir, name))
				if (stat.isFile()) {
					legacyImages++
					legacyImagesBytes += stat.size
				}
			} catch {
				// skip
			}
		}
	} catch {
		// No legacy images dir.
	}
	return { shared: manifest.entries, legacyImages, legacyImagesBytes }
}
