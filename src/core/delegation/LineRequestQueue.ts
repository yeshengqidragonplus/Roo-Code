import * as fs from "fs/promises"
import * as path from "path"
import { randomUUID } from "crypto"

/**
 * Persistent FIFO queue of delegation requests for an expert line session.
 *
 * Phase 4 protocol piece: when a line is busy, new delegation requests are
 * queued (each with a unique requestId) instead of rejected. The queue lives
 * in the line task's own directory (`line-queue.json`) so it disappears with
 * the task — no orphan manifests, same philosophy as the shared-file store.
 *
 * NOTE: under the current single-open invariant the enqueue path is not
 * reachable in practice (the origin is suspended while its line runs, so it
 * cannot delegate again). The queue exists so that when parallel delegation
 * is enabled the routing protocol needs no interface changes. Drain-time
 * validation discards requests whose origin task no longer exists (lazy GC
 * instead of hooking task deletion).
 */

export interface LineRequest {
	/** Unique id for this delegation request (result routing key). */
	requestId: string
	/** Task id of the delegating (originating) session. */
	originTaskId: string
	/** Delegation message (goal + constraints). */
	message: string
	/** Optional images forwarded with the request. */
	images?: string[]
	/** Epoch ms when the request was enqueued. */
	enqueuedAt: number
}

const QUEUE_FILENAME = "line-queue.json"

export class LineRequestQueue {
	private requests: LineRequest[] = []

	private constructor(requests: LineRequest[]) {
		this.requests = requests
	}

	static empty(): LineRequestQueue {
		return new LineRequestQueue([])
	}

	/** Load the queue persisted in a line task's directory (missing file = empty). */
	static async load(taskDir: string): Promise<LineRequestQueue> {
		try {
			const raw = await fs.readFile(path.join(taskDir, QUEUE_FILENAME), "utf8")
			const parsed = JSON.parse(raw)
			if (Array.isArray(parsed)) {
				return new LineRequestQueue(parsed.filter(isLineRequest))
			}
			return new LineRequestQueue([])
		} catch {
			// Missing or corrupt file — treat as empty (best-effort persistence).
			return new LineRequestQueue([])
		}
	}

	/** Persist the queue into a line task's directory. */
	async save(taskDir: string): Promise<void> {
		const file = path.join(taskDir, QUEUE_FILENAME)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(file, JSON.stringify(this.requests, null, "\t") + "\n", "utf8")
	}

	/** Append a request; generates a requestId when omitted. */
	enqueue(req: { originTaskId: string; message: string; images?: string[]; requestId?: string }): LineRequest {
		const entry: LineRequest = {
			requestId: req.requestId ?? randomUUID(),
			originTaskId: req.originTaskId,
			message: req.message,
			...(req.images ? { images: req.images } : {}),
			enqueuedAt: Date.now(),
		}
		this.requests.push(entry)
		return entry
	}

	/** Remove and return the oldest request (undefined when empty). */
	dequeue(): LineRequest | undefined {
		return this.requests.shift()
	}

	/** Oldest request without removing it. */
	peek(): LineRequest | undefined {
		return this.requests[0]
	}

	size(): number {
		return this.requests.length
	}

	isEmpty(): boolean {
		return this.requests.length === 0
	}

	/** All queued requests (read-only view for monitoring UI). */
	all(): readonly LineRequest[] {
		return this.requests
	}

	/** Drop every queued request from a given origin (e.g. origin deleted). */
	removeByOrigin(originTaskId: string): LineRequest[] {
		const removed = this.requests.filter((r) => r.originTaskId === originTaskId)
		this.requests = this.requests.filter((r) => r.originTaskId !== originTaskId)
		return removed
	}

	/** Remove a single request by id. */
	removeById(requestId: string): LineRequest | undefined {
		const index = this.requests.findIndex((r) => r.requestId === requestId)
		if (index === -1) return undefined
		return this.requests.splice(index, 1)[0]
	}
}

function isLineRequest(value: unknown): value is LineRequest {
	if (typeof value !== "object" || value === null) return false
	const v = value as Record<string, unknown>
	return (
		typeof v.requestId === "string" &&
		typeof v.originTaskId === "string" &&
		typeof v.message === "string" &&
		typeof v.enqueuedAt === "number"
	)
}
