import fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { externalizeApiImages, inlineApiImages } from "../apiImageStore"
import type { ApiMessage } from "../apiMessages"

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

function imageMessage(data: string = PNG_BASE64): ApiMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: "look at this" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data } },
		],
	}
}

describe("apiImageStore", () => {
	let taskDir: string

	beforeEach(async () => {
		taskDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-image-store-test-"))
	})

	afterEach(async () => {
		await fs.rm(taskDir, { recursive: true, force: true })
	})

	it("externalize drops base64 from the persisted copy and adds a ref marker", async () => {
		const messages = [imageMessage()]
		const externalized = await externalizeApiImages(messages, taskDir)

		const block = (externalized[0].content as any[])[1]
		expect(block.source.data).toBe("")
		expect(block._imageRef).toMatch(/^roo-image-ref:/)
	})

	it("does NOT mutate the in-memory messages (live send path keeps base64)", async () => {
		const messages = [imageMessage()]
		await externalizeApiImages(messages, taskDir)

		const block = (messages[0].content as any[])[1]
		expect(block.source.data).toBe(PNG_BASE64)
		expect(block._imageRef).toBeUndefined()
	})

	it("round-trips externalize -> inline back to the original base64", async () => {
		const original = [imageMessage()]
		const externalized = await externalizeApiImages(original, taskDir)
		const inlined = await inlineApiImages(externalized, taskDir)

		const block = (inlined[0].content as any[])[1]
		expect(block.source.data).toBe(PNG_BASE64)
		expect(block.source.media_type).toBe("image/png")
		expect(block._imageRef).toBeUndefined()
	})

	it("leaves legacy inline base64 (no _imageRef) untouched on inline", async () => {
		const legacy = [imageMessage()]
		const inlined = await inlineApiImages(legacy, taskDir)

		const block = (inlined[0].content as any[])[1]
		expect(block.source.data).toBe(PNG_BASE64)
	})

	it("ignores messages without array content", async () => {
		const messages: ApiMessage[] = [{ role: "assistant", content: "plain text" }]
		const externalized = await externalizeApiImages(messages, taskDir)
		expect(externalized[0].content).toBe("plain text")
		const inlined = await inlineApiImages(externalized, taskDir)
		expect(inlined[0].content).toBe("plain text")
	})
})
