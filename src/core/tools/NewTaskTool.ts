import * as vscode from "vscode"

import { TodoItem } from "@roo-code/types"

import { Task } from "../task/Task"
import { getModeBySlug } from "../../shared/modes"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { parseMarkdownChecklist } from "./UpdateTodoListTool"
import { Package } from "../../shared/package"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { PIC_REGEX } from "../../api/transform/image-cleaning"
import { isImageRef, refToDataUrl } from "../../integrations/misc/image-store"
import { getTaskDirectoryPath } from "../../utils/storage"

interface NewTaskParams {
	mode: string
	message: string
	todos?: string
}

/**
 * Resolve pic_xxxx identifiers referenced in `message` against the parent task's
 * clineMessages image references, returning the corresponding image dataUrls.
 *
 * Uses the existing `roo-image-ref:` reference mechanism (memory optimization 2-C):
 * clineMessages store image refs (not base64) in their `images[]` arrays. This
 * function matches pic_xxxx identifiers (sha256 prefix) against the ref filenames,
 * resolves them to base64 via `refToDataUrl`, and returns the dataUrls for the
 * child task.
 *
 * - Matching is best-effort: identifiers whose image is no longer in context
 *   are silently skipped so the model can react.
 * - Duplicate identifiers are de-duplicated so each unique image is sent once.
 * - When `message` contains no pic_xxxx identifiers the result is an empty
 *   array, leaving delegation behavior unchanged.
 */
export async function extractImagesFromMessage(message: string, task: Task): Promise<string[]> {
	const picIds = Array.from(message.matchAll(PIC_REGEX)).map((m) => m[1])
	if (picIds.length === 0) {
		return []
	}

	// Collect all image refs from clineMessages (newest first for relevance).
	// Each ref looks like `roo-image-ref:<sha256>.<ext>`; the sha256 prefix
	// matches the picId (first 6 hex chars of sha256).
	const refs: string[] = []
	for (let i = task.clineMessages.length - 1; i >= 0; i--) {
		const msg = task.clineMessages[i]
		if (msg.images) {
			for (const img of msg.images) {
				if (isImageRef(img) && !refs.includes(img)) {
					refs.push(img)
				}
			}
		}
	}

	if (refs.length === 0) {
		return []
	}

	// Get the parent task's directory to resolve refs.
	const taskDir = await getTaskDirectoryPath(task.globalStoragePath, task.taskId)

	const images: string[] = []
	const seen = new Set<string>()
	for (const picId of picIds) {
		if (seen.has(picId)) {
			continue
		}
		seen.add(picId)
		// Find a ref whose filename starts with the picId (sha256 prefix).
		const ref = refs.find((r) => {
			const filename = r.slice("roo-image-ref:".length)
			return filename.startsWith(picId)
		})
		if (ref) {
			try {
				const dataUrl = await refToDataUrl(taskDir, ref)
				images.push(dataUrl)
			} catch {
				// Image file missing/unreadable - skip silently.
			}
		}
	}
	return images
}

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, todos } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters.
			if (!mode) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "mode"))
				return
			}

			if (!message) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "message"))
				return
			}

			// Get the VSCode setting for requiring todos.
			const provider = task.providerRef.deref()

			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			const state = await provider.getState()

			// Use Package.name (dynamic at build time) as the VSCode configuration namespace.
			// Supports multiple extension variants (e.g., stable/nightly) without hardcoded strings.
			const requireTodos = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false)

			// Check if todos are required based on VSCode setting.
			// Note: `undefined` means not provided, empty string is valid.
			if (requireTodos && todos === undefined) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "todos"))
				return
			}

			// Parse todos if provided, otherwise use empty array
			let todoItems: TodoItem[] = []
			if (todos) {
				try {
					todoItems = parseMarkdownChecklist(todos)
				} catch (error) {
					task.consecutiveMistakeCount++
					task.recordToolError("new_task")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError("Invalid todos format: must be a markdown checklist"))
					return
				}
			}

			task.consecutiveMistakeCount = 0

			// Un-escape one level of backslashes before '@' for hierarchical subtasks
			// Un-escape one level: \\@ -> \@ (removes one backslash for hierarchical subtasks)
			const unescapedMessage = message.replace(/\\\\@/g, "\\@")

			// Verify the mode exists
			const targetMode = getModeBySlug(mode, state?.customModes)

			if (!targetMode) {
				pushToolResult(formatResponse.toolError(`Invalid mode: ${mode}`))
				return
			}

			const toolMessage = JSON.stringify({
				tool: "newTask",
				mode: targetMode.name,
				content: message,
				todos: todoItems,
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			// Resolve any pic_xxxx identifiers in the message to image dataUrls from the
			// parent task's clineMessages image references so they can be forwarded to the child.
			const images = await extractImagesFromMessage(unescapedMessage, task)

			// Delegate parent and open child as sole active task
			const child = await (provider as any).delegateParentAndOpenChild({
				parentTaskId: task.taskId,
				message: unescapedMessage,
				initialTodos: todoItems,
				mode,
				// Only pass images when non-empty so the default (empty array) path is unchanged.
				...(images.length > 0 ? { images } : {}),
			})

			// Reflect delegation in tool result (no pause/unpause, no wait)
			pushToolResult(`Delegated to child task ${child.taskId}`)
			return
		} catch (error) {
			await handleError("creating new task", error)
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"new_task">): Promise<void> {
		const mode: string | undefined = block.params.mode
		const message: string | undefined = block.params.message
		const todos: string | undefined = block.params.todos

		const partialMessage = JSON.stringify({
			tool: "newTask",
			mode: mode ?? "",
			content: message ?? "",
			todos: todos,
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const newTaskTool = new NewTaskTool()
