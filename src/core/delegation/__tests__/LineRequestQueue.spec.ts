// npx vitest run core/delegation/__tests__/LineRequestQueue.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { LineRequestQueue } from "../LineRequestQueue"

describe("LineRequestQueue", () => {
	let taskDir: string

	beforeEach(async () => {
		taskDir = await fs.mkdtemp(path.join(os.tmpdir(), "line-queue-test-"))
	})

	afterEach(async () => {
		await fs.rm(taskDir, { recursive: true, force: true })
	})

	it("starts empty when no file exists", async () => {
		const queue = await LineRequestQueue.load(taskDir)
		expect(queue.isEmpty()).toBe(true)
		expect(queue.size()).toBe(0)
	})

	it("enqueue generates a unique requestId and preserves order (FIFO)", () => {
		const queue = LineRequestQueue.empty()
		const a = queue.enqueue({ originTaskId: "task-2", message: "first" })
		const b = queue.enqueue({ originTaskId: "task-20", message: "second" })

		expect(a.requestId).not.toBe(b.requestId)
		expect(queue.size()).toBe(2)
		expect(queue.peek()?.message).toBe("first")
		expect(queue.dequeue()?.message).toBe("first")
		expect(queue.dequeue()?.message).toBe("second")
		expect(queue.dequeue()).toBeUndefined()
	})

	it("persists and reloads across instances", async () => {
		const queue = LineRequestQueue.empty()
		queue.enqueue({ originTaskId: "task-2", message: "persisted", images: ["data:image/png;base64,x"] })
		await queue.save(taskDir)

		const reloaded = await LineRequestQueue.load(taskDir)
		expect(reloaded.size()).toBe(1)
		const req = reloaded.peek()!
		expect(req.originTaskId).toBe("task-2")
		expect(req.message).toBe("persisted")
		expect(req.images).toEqual(["data:image/png;base64,x"])
		expect(typeof req.enqueuedAt).toBe("number")
	})

	it("treats a corrupt file as empty (best-effort persistence)", async () => {
		await fs.writeFile(path.join(taskDir, "line-queue.json"), "not json {{{")
		const queue = await LineRequestQueue.load(taskDir)
		expect(queue.isEmpty()).toBe(true)
	})

	it("filters malformed entries when loading", async () => {
		await fs.writeFile(
			path.join(taskDir, "line-queue.json"),
			JSON.stringify([{ requestId: "r1", originTaskId: "task-2", message: "ok", enqueuedAt: 1 }, { bad: true }]),
		)
		const queue = await LineRequestQueue.load(taskDir)
		expect(queue.size()).toBe(1)
		expect(queue.peek()?.requestId).toBe("r1")
	})

	it("removeByOrigin drops only that origin's requests", () => {
		const queue = LineRequestQueue.empty()
		queue.enqueue({ originTaskId: "task-2", message: "a" })
		queue.enqueue({ originTaskId: "task-20", message: "b" })
		queue.enqueue({ originTaskId: "task-2", message: "c" })

		const removed = queue.removeByOrigin("task-2")
		expect(removed.length).toBe(2)
		expect(queue.size()).toBe(1)
		expect(queue.peek()?.originTaskId).toBe("task-20")
	})

	it("removeById removes exactly one request", () => {
		const queue = LineRequestQueue.empty()
		const a = queue.enqueue({ originTaskId: "task-2", message: "a" })
		queue.enqueue({ originTaskId: "task-2", message: "b" })

		const removed = queue.removeById(a.requestId)
		expect(removed?.requestId).toBe(a.requestId)
		expect(queue.size()).toBe(1)
		expect(queue.removeById("no-such-id")).toBeUndefined()
	})
})
