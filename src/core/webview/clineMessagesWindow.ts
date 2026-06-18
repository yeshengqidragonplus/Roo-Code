/**
 * @fileoverview Host-side helpers for sending clineMessages to the webview in a bounded window.
 *
 * The webview mirrors clineMessages in React state. On very long tasks that full array is a large
 * memory cost duplicated host↔webview (2-A). These helpers let the host send only the most recent
 * window and serve older slices on demand, while keeping subtask links correct.
 *
 * `stampSubtaskChildIds` resolves each `newTask` message's child task id from the FULL history before
 * windowing, so the webview never has to derive it by counting newTask messages (which would be wrong
 * once the array is windowed).
 */

import { safeJsonParse } from "@roo-code/core"
import type { ClineMessage, ClineSayTool } from "@roo-code/types"

/**
 * Default number of trailing clineMessages sent to the webview. Chosen large enough that typical
 * tasks send their entire history (so behavior is unchanged); only very long tasks get windowed.
 */
export const CLINE_MESSAGES_WINDOW_SIZE = 300

function isNewTaskMessage(message: ClineMessage): boolean {
	if (message.type === "ask" && message.ask === "tool") {
		return safeJsonParse<ClineSayTool>(message.text)?.tool === "newTask"
	}
	return false
}

/**
 * Stamp each `newTask` message with its resolved `childTaskId` (by global ordinal among newTask
 * messages) so it survives windowing. Returns shallow copies only for the newTask messages that
 * resolve to a child id; everything else is passed through by reference.
 */
export function stampSubtaskChildIds(messages: ClineMessage[], childIds: string[]): ClineMessage[] {
	if (childIds.length === 0) {
		return messages
	}
	let newTaskOrdinal = 0
	return messages.map((message) => {
		if (!isNewTaskMessage(message)) {
			return message
		}
		const childTaskId = newTaskOrdinal < childIds.length ? childIds[newTaskOrdinal] : undefined
		newTaskOrdinal++
		return childTaskId !== undefined ? { ...message, childTaskId } : message
	})
}

/** Return the trailing window of `messages` (the last `windowSize`). */
export function windowClineMessages(
	messages: ClineMessage[],
	windowSize: number = CLINE_MESSAGES_WINDOW_SIZE,
): ClineMessage[] {
	if (messages.length <= windowSize) {
		return messages
	}
	return messages.slice(messages.length - windowSize)
}

/**
 * Return the window of older messages immediately preceding `beforeTs`, for on-demand back-paging.
 * Returns at most `windowSize` messages ending just before the first message whose ts === beforeTs.
 */
export function olderClineMessagesBefore(
	messages: ClineMessage[],
	beforeTs: number,
	windowSize: number = CLINE_MESSAGES_WINDOW_SIZE,
): ClineMessage[] {
	const idx = messages.findIndex((m) => m.ts === beforeTs)
	if (idx <= 0) {
		return []
	}
	return messages.slice(Math.max(0, idx - windowSize), idx)
}
