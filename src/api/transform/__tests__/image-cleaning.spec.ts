// npx vitest run api/transform/__tests__/image-cleaning.spec.ts

import { createHash } from "crypto"

import type { ModelInfo } from "@roo-code/types"

import { ApiHandler } from "../../index"
import { ApiMessage } from "../../../core/task-persistence/apiMessages"
import { computePicId, findImageByPicId, imageBlockToDataUrl, maybeRemoveImageBlocks } from "../image-cleaning"

describe("maybeRemoveImageBlocks", () => {
	// Mock ApiHandler factory function
	const createMockApiHandler = (supportsImages: boolean): ApiHandler => {
		return {
			getModel: vitest.fn().mockReturnValue({
				id: "test-model",
				info: {
					supportsImages,
				} as ModelInfo,
			}),
			createMessage: vitest.fn(),
			countTokens: vitest.fn(),
		}
	}

	it("should handle empty messages array", () => {
		const apiHandler = createMockApiHandler(true)
		const messages: ApiMessage[] = []

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		expect(result).toEqual([])
		// No need to check if getModel was called since there are no messages to process
	})

	it("should not modify messages with no image blocks", () => {
		const apiHandler = createMockApiHandler(true)
		const messages: ApiMessage[] = [
			{
				role: "user",
				content: "Hello, world!",
			},
			{
				role: "assistant",
				content: "Hi there!",
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		expect(result).toEqual(messages)
		// getModel is only called when content is an array, which is not the case here
	})

	it("should not modify messages with array content but no image blocks", () => {
		const apiHandler = createMockApiHandler(true)
		const messages: ApiMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Hello, world!",
					},
					{
						type: "text",
						text: "How are you?",
					},
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		expect(result).toEqual(messages)
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should not modify image blocks when API handler supports images", () => {
		const apiHandler = createMockApiHandler(true)
		const messages: ApiMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Check out this image:",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "base64-encoded-image-data",
						},
					},
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should not modify the messages since the API handler supports images
		expect(result).toEqual(messages)
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should convert image blocks to pic_xxxx text when API handler doesn't support images", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Check out this image:",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "base64-encoded-image-data",
						},
					},
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should convert image blocks to a stable pic_xxxx identifier
		const replacedBlock = (result[0].content as any[])[1]
		expect(replacedBlock.type).toBe("text")
		expect(replacedBlock.text).toMatch(/^\[图片: pic_[a-f0-9]{6}\]$/)

		// The picId must match the sha256 prefix of the canonical dataUrl
		const expectedPicId = createHash("sha256")
			.update("data:image/jpeg;base64,base64-encoded-image-data")
			.digest("hex")
			.slice(0, 6)
		expect(replacedBlock.text).toBe(`[图片: pic_${expectedPicId}]`)
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should handle mixed content messages with multiple text and image blocks", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Here are some images:",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "image-data-1",
						},
					},
					{
						type: "text",
						text: "And another one:",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "image-data-2",
						},
					},
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should convert all image blocks to pic_xxxx identifiers
		const block = result[0].content as any[]
		expect(block[1].text).toMatch(/^\[图片: pic_[a-f0-9]{6}\]$/)
		expect(block[3].text).toMatch(/^\[图片: pic_[a-f0-9]{6}\]$/)
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should handle multiple messages with image blocks", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Here's an image:",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "image-data-1",
						},
					},
				],
			},
			{
				role: "assistant",
				content: "I see the image!",
			},
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Here's another image:",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "image-data-2",
						},
					},
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should convert all image blocks to pic_xxxx identifiers across messages
		const user1Block = (result[0].content as any[])[1]
		const user2Block = (result[2].content as any[])[1]
		expect(user1Block.text).toMatch(/^\[图片: pic_[a-f0-9]{6}\]$/)
		expect(user2Block.text).toMatch(/^\[图片: pic_[a-f0-9]{6}\]$/)
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should preserve additional message properties", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Here's an image:",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "image-data",
						},
					},
				],
				ts: 1620000000000,
				isSummary: true,
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should convert image blocks to pic_xxxx while preserving additional properties
		const replacedBlock = (result[0].content as any[])[1]
		expect(replacedBlock.text).toMatch(/^\[图片: pic_[a-f0-9]{6}\]$/)
		expect(result[0].ts).toBe(1620000000000)
		expect(result[0].isSummary).toBe(true)
		expect(apiHandler.getModel).toHaveBeenCalled()
	})
})

describe("pic_xxxx identifier generation", () => {
	const createMockApiHandler = (supportsImages: boolean): ApiHandler => {
		return {
			getModel: vitest.fn().mockReturnValue({
				id: "test-model",
				info: { supportsImages } as ModelInfo,
			}),
			createMessage: vitest.fn(),
			countTokens: vitest.fn(),
		}
	}

	// Canonical dataUrl whose sha256 prefix is deterministic across runs.
	const DATA_URL = "data:image/png;base64,iVBORw0KGgo="
	const PIC_ID = createHash("sha256").update(DATA_URL).digest("hex").slice(0, 6)

	const imageBlock = (
		data: string,
		mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" = "image/png",
	) => ({
		type: "image" as const,
		source: { type: "base64" as const, media_type: mediaType, data },
	})

	it("should generate the same picId for the same image across occurrences", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{ role: "user", content: [imageBlock("iVBORw0KGgo=")] },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: [imageBlock("iVBORw0KGgo=")] },
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)
		const first = (result[0].content as any[])[0].text
		const second = (result[2].content as any[])[0].text
		expect(first).toBe(second)
		expect(first).toBe(`[图片: pic_${PIC_ID}]`)
	})

	it("should generate different picIds for different images", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{
				role: "user",
				content: [imageBlock("aaaa"), imageBlock("bbbb")],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)
		const first = (result[0].content as any[])[0].text
		const second = (result[0].content as any[])[1].text
		expect(first).not.toBe(second)
		expect(first).toMatch(/^\[图片: pic_[a-f0-9]{6}\]$/)
		expect(second).toMatch(/^\[图片: pic_[a-f0-9]{6}\]$/)
	})

	it("computePicId should be the sha256 prefix of the dataUrl", () => {
		expect(computePicId(DATA_URL)).toBe(PIC_ID)
		expect(PIC_ID).toHaveLength(6)
		expect(PIC_ID).toMatch(/^[a-f0-9]{6}$/)
	})

	it("imageBlockToDataUrl should canonicalize base64 source to a dataUrl", () => {
		const block = imageBlock("iVBORw0KGgo=")
		expect(imageBlockToDataUrl(block)).toBe(DATA_URL)
	})

	it("imageBlockToDataUrl should return undefined for non-image blocks", () => {
		expect(imageBlockToDataUrl({ type: "text", text: "hi" })).toBeUndefined()
		expect(imageBlockToDataUrl(undefined)).toBeUndefined()
	})

	it("findImageByPicId should resolve a matching image from history", () => {
		const history: ApiMessage[] = [{ role: "user", content: [imageBlock("iVBORw0KGgo=")] }]
		expect(findImageByPicId(history, PIC_ID)).toBe(DATA_URL)
	})

	it("findImageByPicId should return undefined when no image matches", () => {
		const history: ApiMessage[] = [{ role: "user", content: [imageBlock("iVBORw0KGgo=")] }]
		expect(findImageByPicId(history, "000000")).toBeUndefined()
		expect(findImageByPicId([], PIC_ID)).toBeUndefined()
	})
})
