import fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	IMAGE_REF_PREFIX,
	isImageRef,
	isDataUrl,
	parseDataUrl,
	refToAbsPath,
	storeImage,
	storeImages,
	refToDataUrl,
	resolveImageToDataUrl,
	resolveImagesForDisplay,
} from "../image-store"

// A 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

describe("image-store", () => {
	let taskDir: string

	beforeEach(async () => {
		taskDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-store-test-"))
	})

	afterEach(async () => {
		await fs.rm(taskDir, { recursive: true, force: true })
	})

	describe("predicates", () => {
		it("distinguishes refs, data URIs, and other strings", () => {
			expect(isImageRef(`${IMAGE_REF_PREFIX}abc.png`)).toBe(true)
			expect(isImageRef(PNG_DATA_URL)).toBe(false)
			expect(isDataUrl(PNG_DATA_URL)).toBe(true)
			expect(isDataUrl(`${IMAGE_REF_PREFIX}abc.png`)).toBe(false)
		})
	})

	describe("parseDataUrl", () => {
		it("splits mime and base64", () => {
			expect(parseDataUrl(PNG_DATA_URL)).toEqual({ mimeType: "image/png", base64: PNG_BASE64 })
		})
		it("returns null for non-data URIs", () => {
			expect(parseDataUrl(`${IMAGE_REF_PREFIX}abc.png`)).toBeNull()
		})
	})

	describe("storeImage", () => {
		it("writes the bytes once and returns a content-addressed ref", async () => {
			const ref = await storeImage(taskDir, PNG_DATA_URL)
			expect(isImageRef(ref)).toBe(true)

			const absPath = refToAbsPath(taskDir, ref)
			const onDisk = await fs.readFile(absPath)
			expect(onDisk.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true)
			// File name is the sha256 of the bytes.
			expect(path.basename(absPath)).toMatch(/^[a-f0-9]{64}\.png$/)
		})

		it("dedupes identical content to the same ref", async () => {
			const a = await storeImage(taskDir, PNG_DATA_URL)
			const b = await storeImage(taskDir, PNG_DATA_URL)
			expect(a).toBe(b)
		})

		it("passes through values that are not data URIs", async () => {
			const alreadyRef = `${IMAGE_REF_PREFIX}abc.png`
			expect(await storeImage(taskDir, alreadyRef)).toBe(alreadyRef)
		})
	})

	describe("round-trip", () => {
		it("storeImage -> refToDataUrl reproduces the original data URI", async () => {
			const ref = await storeImage(taskDir, PNG_DATA_URL)
			expect(await refToDataUrl(taskDir, ref)).toBe(PNG_DATA_URL)
		})

		it("storeImages handles a mixed array", async () => {
			const refs = await storeImages(taskDir, [PNG_DATA_URL, `${IMAGE_REF_PREFIX}keep.png`])
			expect(isImageRef(refs[0])).toBe(true)
			expect(refs[1]).toBe(`${IMAGE_REF_PREFIX}keep.png`)
		})

		it("resolveImageToDataUrl reads refs and passes through legacy base64", async () => {
			const ref = await storeImage(taskDir, PNG_DATA_URL)
			expect(await resolveImageToDataUrl(taskDir, ref)).toBe(PNG_DATA_URL)
			// Legacy base64 entries (older tasks) are returned untouched.
			expect(await resolveImageToDataUrl(taskDir, PNG_DATA_URL)).toBe(PNG_DATA_URL)
		})
	})

	describe("resolveImagesForDisplay", () => {
		it("maps refs through the resolver and passes base64 through unchanged", () => {
			const toUri = (absPath: string) => `vscode-webview://host/${path.basename(absPath)}`
			const result = resolveImagesForDisplay(
				taskDir,
				[`${IMAGE_REF_PREFIX}abc.png`, PNG_DATA_URL, `${IMAGE_REF_PREFIX}def.webp`],
				toUri,
			)
			expect(result[0]).toBe("vscode-webview://host/abc.png")
			expect(result[1]).toBe(PNG_DATA_URL)
			expect(result[2]).toBe("vscode-webview://host/def.webp")
		})

		it("returns identical content when there are no refs (resolver never called)", () => {
			const toUri = vi.fn((absPath: string) => absPath)
			const result = resolveImagesForDisplay(taskDir, [PNG_DATA_URL], toUri)
			expect(result).toEqual([PNG_DATA_URL])
			expect(toUri).not.toHaveBeenCalled()
		})
	})

	describe("refToAbsPath", () => {
		it("strips any path traversal from the token", () => {
			const ref = `${IMAGE_REF_PREFIX}../../etc/passwd`
			expect(refToAbsPath(taskDir, ref)).toBe(path.join(taskDir, "images", "passwd"))
		})
	})
})
