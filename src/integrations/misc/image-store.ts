/**
 * @fileoverview Content-addressed on-disk image store.
 *
 * Images used to live as base64 `data:` URIs everywhere — in memory (clineMessages /
 * apiConversationHistory), on disk (task JSON), and over the host<->webview bus. A single
 * screenshot is 0.5–2MB, so they dominated memory on long tasks (see docs/memory-optimization.md, 2-C).
 *
 * This module persists the bytes once under `<taskDir>/images/<sha256>.<ext>` and hands back a
 * lightweight **reference token** (`roo-image-ref:<filename>`). The token is carried in the
 * existing `images: string[]` fields instead of the base64. The token prefix is intentionally
 * distinguishable from `data:` so every consumer can branch:
 *   - `data:...`            → legacy base64 (older tasks keep working, no migration)
 *   - `roo-image-ref:...`   → resolve to a file path / base64 / webview URI on demand
 *
 * base64 is reconstructed only at the two moments it is actually required: sending to the model,
 * and rendering in the webview.
 */

import fs from "fs/promises"
import * as path from "path"
import * as crypto from "crypto"

export const IMAGE_REF_PREFIX = "roo-image-ref:"
const IMAGES_DIR = "images"

const MIME_TO_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
}

const EXT_TO_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
}

/** Whether a value stored in an `images[]` slot is a reference token (vs a legacy base64 data URI). */
export function isImageRef(value: string): boolean {
	return value.startsWith(IMAGE_REF_PREFIX)
}

/** Whether a value is a base64 `data:image/...` URI. */
export function isDataUrl(value: string): boolean {
	return value.startsWith("data:")
}

/** Parse a `data:<mime>;base64,<data>` URI into its parts, or null if it isn't one. */
export function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
	if (!isDataUrl(dataUrl)) {
		return null
	}
	const commaIdx = dataUrl.indexOf(",")
	if (commaIdx === -1) {
		return null
	}
	const header = dataUrl.slice(5, commaIdx) // strip "data:"
	const base64 = dataUrl.slice(commaIdx + 1)
	const mimeType = header.split(";")[0] || "image/png"
	return { mimeType, base64 }
}

/** Resolve a reference token to the absolute file path of the stored image. */
export function refToAbsPath(taskDir: string, ref: string): string {
	const filename = ref.slice(IMAGE_REF_PREFIX.length)
	// Guard against path traversal — the token only ever carries a bare filename.
	const safeName = path.basename(filename)
	return path.join(taskDir, IMAGES_DIR, safeName)
}

/**
 * Persist a base64 data URI to `<taskDir>/images/<sha256>.<ext>` and return its reference token.
 * Content-addressed: identical images dedupe to the same file. If the input is not a data URI it
 * is returned unchanged (already a ref, or an unexpected value — callers stay robust).
 */
export async function storeImage(taskDir: string, dataUrl: string): Promise<string> {
	const parsed = parseDataUrl(dataUrl)
	if (!parsed) {
		return dataUrl
	}

	const buffer = Buffer.from(parsed.base64, "base64")
	const hash = crypto.createHash("sha256").update(buffer).digest("hex")
	const ext = MIME_TO_EXT[parsed.mimeType.toLowerCase()] ?? "png"
	const filename = `${hash}.${ext}`
	const imagesDir = path.join(taskDir, IMAGES_DIR)
	const filePath = path.join(imagesDir, filename)

	// Skip the write if the content-addressed file already exists.
	try {
		await fs.access(filePath)
	} catch {
		await fs.mkdir(imagesDir, { recursive: true })
		await fs.writeFile(filePath, buffer)
	}

	return `${IMAGE_REF_PREFIX}${filename}`
}

/** Convenience: store every entry, replacing data URIs with refs and leaving other values intact. */
export async function storeImages(taskDir: string, images: string[]): Promise<string[]> {
	return Promise.all(images.map((image) => storeImage(taskDir, image)))
}

/** Read a referenced image back as a base64 `data:` URI (used right before sending to the model). */
export async function refToDataUrl(taskDir: string, ref: string): Promise<string> {
	const absPath = refToAbsPath(taskDir, ref)
	const buffer = await fs.readFile(absPath)
	const ext = path.extname(absPath).slice(1).toLowerCase()
	const mimeType = EXT_TO_MIME[ext] ?? "image/png"
	return `data:${mimeType};base64,${buffer.toString("base64")}`
}

/**
 * Resolve an `images[]` entry to a base64 data URI: refs are read from disk, legacy data URIs are
 * passed through. Used at the model-send boundary where base64 is mandatory.
 */
export async function resolveImageToDataUrl(taskDir: string, image: string): Promise<string> {
	return isImageRef(image) ? refToDataUrl(taskDir, image) : image
}
