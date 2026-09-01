import { z } from "zod"

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	mode: z.string().optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	status: z.enum(["active", "completed", "delegated", "idle"]).optional(),
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
	/**
	 * Session kind: a normal task (default/omitted) or an expert line session.
	 * Expert lines are reusable delegation sessions keyed by (origin task, expert mode).
	 * See docs/expert-line-sessions-design.md.
	 */
	sessionKind: z.enum(["main", "expert-line"]).optional(),
	/** Expert-line only: task id of the originating session (routing key half). */
	lineOriginTaskId: z.string().optional(),
	/** Expert-line only: expert mode slug (routing key half). */
	lineExpertMode: z.string().optional(),
	/** Expert-line only: number of delegation requests served on this line. */
	lineRequestCount: z.number().optional(),
	/** Expert-line only: consecutive failed requests (rotation trigger). */
	lineConsecutiveFailures: z.number().optional(),
})

export type HistoryItem = z.infer<typeof historyItemSchema>
