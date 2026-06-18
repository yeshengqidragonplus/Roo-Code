import type { ClineMessage } from "@roo-code/types"

import {
	stampSubtaskChildIds,
	windowClineMessages,
	olderClineMessagesBefore,
	CLINE_MESSAGES_WINDOW_SIZE,
} from "../clineMessagesWindow"

function say(ts: number, text = ""): ClineMessage {
	return { ts, type: "say", say: "text", text }
}

function newTaskAsk(ts: number): ClineMessage {
	return { ts, type: "ask", ask: "tool", text: JSON.stringify({ tool: "newTask", content: "do x" }) }
}

describe("clineMessagesWindow", () => {
	describe("stampSubtaskChildIds", () => {
		it("stamps each newTask message with its child id by global ordinal", () => {
			const messages = [say(1), newTaskAsk(2), say(3), newTaskAsk(4)]
			const result = stampSubtaskChildIds(messages, ["child-a", "child-b"])
			expect(result[1].childTaskId).toBe("child-a")
			expect(result[3].childTaskId).toBe("child-b")
			// Non-newTask messages untouched (same reference).
			expect(result[0]).toBe(messages[0])
		})

		it("leaves newTask messages without a matching child id unstamped", () => {
			const messages = [newTaskAsk(1), newTaskAsk(2)]
			const result = stampSubtaskChildIds(messages, ["only-one"])
			expect(result[0].childTaskId).toBe("only-one")
			expect(result[1].childTaskId).toBeUndefined()
		})

		it("is a no-op when there are no child ids", () => {
			const messages = [newTaskAsk(1)]
			expect(stampSubtaskChildIds(messages, [])).toBe(messages)
		})
	})

	describe("windowClineMessages", () => {
		it("returns the whole array when within the window", () => {
			const messages = [say(1), say(2), say(3)]
			expect(windowClineMessages(messages, 10)).toBe(messages)
		})

		it("returns only the trailing window when longer", () => {
			const messages = [say(1), say(2), say(3), say(4), say(5)]
			const result = windowClineMessages(messages, 2)
			expect(result.map((m) => m.ts)).toEqual([4, 5])
		})

		it("defaults to CLINE_MESSAGES_WINDOW_SIZE", () => {
			const messages = Array.from({ length: CLINE_MESSAGES_WINDOW_SIZE + 5 }, (_, i) => say(i))
			expect(windowClineMessages(messages)).toHaveLength(CLINE_MESSAGES_WINDOW_SIZE)
		})
	})

	describe("olderClineMessagesBefore", () => {
		it("returns the window of messages immediately preceding beforeTs", () => {
			const messages = [say(1), say(2), say(3), say(4), say(5)]
			const result = olderClineMessagesBefore(messages, 4, 2)
			expect(result.map((m) => m.ts)).toEqual([2, 3])
		})

		it("returns empty when beforeTs is the first message or not found", () => {
			const messages = [say(1), say(2), say(3)]
			expect(olderClineMessagesBefore(messages, 1, 2)).toEqual([])
			expect(olderClineMessagesBefore(messages, 999, 2)).toEqual([])
		})

		it("clamps to the start of the array", () => {
			const messages = [say(1), say(2), say(3)]
			const result = olderClineMessagesBefore(messages, 3, 10)
			expect(result.map((m) => m.ts)).toEqual([1, 2])
		})
	})
})
