import crypto from "crypto"

import { ApiMessage } from "../../core/task-persistence/apiMessages"

import { ApiHandler } from "../index"

// Image blocks use the Anthropic source shape: { type: "image", source: { type: "base64", media_type, data } }.
// We canonicalize to a dataUrl string so the same identifier is computed in both image-cleaning
// (when the model doesn't support images) and NewTaskTool (when resolving pic_xxxx references).
// NOTE: `import type Anthropic` avoids a runtime dependency here; we cast defensively instead.

/** sha256(input) truncated to 6 hex chars, used as the pic_xxxx identifier. */
export function computePicId(dataUrl: string): string {
	return crypto.createHash("sha256").update(dataUrl).digest("hex").slice(0, 6)
}

/**
 * Extract the canonical dataUrl from an image content block.
 * Supports the Anthropic base64 source shape: { type: "image", source: { type: "base64", media_type, data } }.
 * Returns undefined for blocks that don't carry extractable base64 image data (e.g. url-only sources),
 * so callers can decide how to handle them.
 */
export function imageBlockToDataUrl(block: any): string | undefined {
	// Anthropic base64 source: block.source.data holds raw base64 (no data: prefix).
	const source = block?.source
	if (source && source.type === "base64" && source.media_type && source.data) {
		return `data:${source.media_type};base64,${source.data}`
	}
	// Fallback: some block variants carry an already-prefixed dataUrl or image_url.
	if (typeof block?.image === "string" && block.image.startsWith("data:")) {
		return block.image
	}
	if (typeof block?.image_url?.url === "string" && block.image_url.url.startsWith("data:")) {
		return block.image_url.url
	}
	return undefined
}

/** Regex matching pic_xxxx identifiers (6 hex chars) within message text. */
export const PIC_REGEX = /pic_([a-f0-9]{6})/g

/**
 * Scan an apiConversationHistory for image blocks whose picId matches the given hex prefix.
 * Returns the matching dataUrl (first match wins) or undefined when no image remains in context
 * (e.g. removed by condensation). Never throws.
 */
export function findImageByPicId(history: ApiMessage[], picId: string): string | undefined {
	for (const message of history) {
		const { content } = message
		if (!Array.isArray(content)) {
			continue
		}
		for (const block of content) {
			if (block.type !== "image") {
				continue
			}
			const dataUrl = imageBlockToDataUrl(block)
			if (dataUrl && computePicId(dataUrl) === picId) {
				return dataUrl
			}
		}
	}
	return undefined
}

/* Removes image blocks from messages if they are not supported by the Api Handler. */
export function maybeRemoveImageBlocks(messages: ApiMessage[], apiHandler: ApiHandler): ApiMessage[] {
	// Check model capability ONCE instead of for every message
	const supportsImages = apiHandler.getModel().info.supportsImages

	return messages.map((message) => {
		// Handle array content (could contain image blocks).
		let { content } = message
		if (Array.isArray(content)) {
			if (!supportsImages) {
				// Convert image blocks to text descriptions.
				content = content.map((block) => {
					if (block.type === "image") {
						// Replace image blocks with a stable pic_xxxx identifier derived from the image
						// dataUrl, so the model can reference the image (e.g. via new_task) even though it
						// can't see the image directly. When the dataUrl can't be extracted we fall back to
						// the legacy placeholder so behavior is unchanged for exotic block shapes.
						const dataUrl = imageBlockToDataUrl(block)
						const text = dataUrl
							? `[图片: pic_${computePicId(dataUrl)}]`
							: "[Referenced image in conversation]"
						return { type: "text", text }
					}
					return block
				})
			}
		}
		return { ...message, content }
	})
}
