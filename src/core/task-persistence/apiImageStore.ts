/**
 * @fileoverview Externalize / inline base64 image blocks in the API conversation history.
 *
 * `apiConversationHistory` is the array literally sent to the model, so its image blocks must carry
 * base64 (`source: { type: "base64", data }`) in memory and at send time. But persisting that base64
 * into `api_conversation_history.json` bloats the file by megabytes per screenshot (2-C, sub-step C4).
 *
 * These transforms operate **only at the disk boundary**:
 *   - {@link externalizeApiImages} runs before save: deep-clones the messages, writes each base64
 *     image to the shared content-addressed image store, and replaces the block's data with an
 *     `_imageRef` marker. The in-memory array passed in is never mutated, so the live send path keeps
 *     its base64 untouched (zero risk to model calls).
 *   - {@link inlineApiImages} runs after read: restores base64 into any block carrying an `_imageRef`.
 *
 * Backward compatible: legacy files have inline base64 and no `_imageRef`, so inlining is a no-op for
 * them and they keep working with no migration.
 */

import { Anthropic } from "@anthropic-ai/sdk"

import { storeImage, refToDataUrl, parseDataUrl } from "../../integrations/misc/image-store"
import type { ApiMessage } from "./apiMessages"

/** Marker field added to a persisted image block pointing at the externalized file. */
const IMAGE_REF_FIELD = "_imageRef"

type Base64ImageBlock = Anthropic.ImageBlockParam & {
	source: { type: "base64"; media_type: string; data: string }
	[IMAGE_REF_FIELD]?: string
}

function isBase64ImageBlock(block: unknown): block is Base64ImageBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: string }).type === "image" &&
		(block as { source?: { type?: string } }).source?.type === "base64"
	)
}

/** Deep-clone messages and replace base64 image blocks with on-disk refs for persistence. */
export async function externalizeApiImages(messages: ApiMessage[], taskDir: string): Promise<ApiMessage[]> {
	// structuredClone keeps the in-memory `messages` (with base64) intact for the live send path.
	const cloned: ApiMessage[] = structuredClone(messages)

	for (const message of cloned) {
		if (!Array.isArray(message.content)) {
			continue
		}
		for (const block of message.content) {
			if (!isBase64ImageBlock(block) || block[IMAGE_REF_FIELD]) {
				continue
			}
			try {
				const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`
				const ref = await storeImage(taskDir, dataUrl)
				block[IMAGE_REF_FIELD] = ref
				block.source.data = "" // drop the heavy base64 from the persisted JSON
			} catch (error) {
				// Keep the inline base64 if storing fails — correctness over footprint.
				console.error("[externalizeApiImages] Failed to externalize image, keeping inline base64:", error)
			}
		}
	}

	return cloned
}

/** Restore base64 into any image blocks that were externalized to refs. Mutates and returns input. */
export async function inlineApiImages(messages: ApiMessage[], taskDir: string): Promise<ApiMessage[]> {
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue
		}
		for (const block of message.content) {
			if (!isBase64ImageBlock(block)) {
				continue
			}
			const ref = block[IMAGE_REF_FIELD]
			if (!ref) {
				continue // legacy inline base64, or already inlined
			}
			try {
				const dataUrl = await refToDataUrl(taskDir, ref)
				const parsed = parseDataUrl(dataUrl)
				if (parsed) {
					block.source.media_type = parsed.mimeType as Base64ImageBlock["source"]["media_type"]
					block.source.data = parsed.base64
				}
				delete block[IMAGE_REF_FIELD]
			} catch (error) {
				// Image file missing/unreadable — leave the marker and log; better than crashing the read.
				console.error("[inlineApiImages] Failed to inline externalized image:", error)
			}
		}
	}

	return messages
}
