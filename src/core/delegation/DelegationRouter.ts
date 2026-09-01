import type { HistoryItem, TodoItem } from "@roo-code/types"

import type { Task } from "../task/Task"
import { getModeBySlug } from "../../shared/modes"
import { LineRequestQueue } from "./LineRequestQueue"

/**
 * Expert line sessions — host-enforced delegation routing.
 *
 * Routing key = (originating task id, expert mode slug). The first delegation
 * from task S to expert C creates a dedicated line session (a child task
 * tagged with sessionKind="expert-line"); subsequent delegations from the
 * SAME task S to the SAME expert C resume that line and append the new
 * request as a user message (context continuity is a feature). Delegations
 * from a different task S' get a physically separate line — cross-origin
 * isolation is structural, not prompt-level.
 *
 * Phase 4: busy lines queue requests (LineRequestQueue, persisted in the
 * line task's directory) instead of rejecting them; lines rotate (close +
 * recreate) after too many requests or consecutive failures.
 *
 * See docs/expert-line-sessions-design.md.
 */

/** Rotation policy for expert lines (Phase 4). */
export interface LineRotationPolicy {
	/** Close the line after this many requests served (context hygiene). */
	maxRequestsPerLine?: number
	/** Close the line after this many consecutive failed requests. */
	maxConsecutiveFailures?: number
}

export const DEFAULT_ROTATION_POLICY: Required<LineRotationPolicy> = {
	maxRequestsPerLine: 20,
	maxConsecutiveFailures: 3,
}

/** Dependencies injected so the routing logic is testable in isolation. */
export interface DelegationRouterDeps {
	/** All persisted history items (scanned to find active/idle lines). */
	getHistoryItems: () => HistoryItem[]
	/** Provider state (for customModes lookups). */
	getState: () => Promise<{ customModes?: any[] }>
	/** Legacy one-shot delegation (creates a fresh child task). */
	delegateAndOpenChild: (params: {
		parentTaskId: string
		message: string
		initialTodos: TodoItem[]
		mode: string
		images?: string[]
		lineMetadata?: LineMetadata
	}) => Promise<Task>
	/** Resume an idle expert line and inject a new request. */
	resumeLineSession: (params: {
		originTaskId: string
		lineHistoryItem: HistoryItem
		message: string
		images?: string[]
	}) => Promise<Task>
	/** Resolve a task's directory (for the persisted request queue). */
	getTaskDirectoryPath: (globalStoragePath: string, taskId: string) => Promise<string>
	/** Global storage root (queue files live under each line task's dir). */
	globalStoragePath: string
	/** Provider log sink. */
	log: (message: string) => void
}

/** Metadata tagging a child task as an expert line session. */
export interface LineMetadata {
	originTaskId: string
	expertMode: string
}

export interface RouteDelegationParams {
	/** Task id of the delegating (originating) session. */
	originTaskId: string
	/** Slug of the expert mode being delegated to. */
	expertMode: string
	/** Delegation message (goal + constraints for the expert). */
	message: string
	images?: string[]
	initialTodos?: TodoItem[]
	/** Slug of the originating task's mode (for the workgroup gate). */
	parentModeSlug?: string
}

/** Outcome of routing a delegation request. */
export interface RouteDelegationResult {
	/** The line/child task that will serve the request (or the busy line). */
	task: Task
	/** True when an existing idle line was resumed. */
	reused: boolean
	/** True when the request was queued on a busy line (Phase 4). */
	queued?: boolean
	/** Request id (set when queued; the result-routing key). */
	requestId?: string
	/** True when the previous line was rotated (closed) and a new one created. */
	rotated?: boolean
}

/**
 * Wrap a delegation request with an explicit boundary marker so the expert
 * can tell request N on this line apart from earlier requests whose context
 * it still carries.
 */
export function frameDelegationRequest(number: number, originTaskId: string, message: string): string {
	return `<delegation_request number="${number}" origin="${originTaskId}">\n${message}\n</delegation_request>`
}

export class DelegationRouter {
	constructor(
		private readonly deps: DelegationRouterDeps,
		private readonly rotationPolicy: LineRotationPolicy = DEFAULT_ROTATION_POLICY,
	) {}

	/**
	 * Find the reusable expert line for (originTaskId, expertMode).
	 * Only lines in "active" or "idle" status qualify; "completed" lines are
	 * closed and a new line must be created on the next delegation.
	 */
	findLine(originTaskId: string, expertMode: string): HistoryItem | undefined {
		return this.deps.getHistoryItems().find(
			(item) =>
				item.sessionKind === "expert-line" &&
				item.lineOriginTaskId === originTaskId &&
				item.lineExpertMode === expertMode &&
				(item.status === "active" || item.status === "idle"),
		)
	}

	/** Load the persisted request queue for a line task. */
	async loadQueue(lineTaskId: string): Promise<LineRequestQueue> {
		const taskDir = await this.deps.getTaskDirectoryPath(this.deps.globalStoragePath, lineTaskId)
		return LineRequestQueue.load(taskDir)
	}

	/**
	 * Whether a line should be rotated (closed) before serving another
	 * request: too many requests served, or too many consecutive failures.
	 */
	shouldRotate(line: HistoryItem): boolean {
		const policy = { ...DEFAULT_ROTATION_POLICY, ...this.rotationPolicy }
		const served = line.lineRequestCount ?? 0
		const failures = line.lineConsecutiveFailures ?? 0
		return served >= policy.maxRequestsPerLine || failures >= policy.maxConsecutiveFailures
	}

	/**
	 * Whether this delegation should use expert-line routing. Gate (v1):
	 * only expert modes (kind declared) or workgroup-originating delegations
	 * use lines; plain-mode delegations keep the legacy one-shot child task.
	 */
	async shouldUseLineRouting(expertMode: string, parentModeSlug?: string): Promise<boolean> {
		const state = await this.deps.getState()
		const targetMode = getModeBySlug(expertMode, state.customModes)
		if (targetMode?.kind) {
			return true
		}
		if (parentModeSlug) {
			const parentMode = getModeBySlug(parentModeSlug, state.customModes)
			if (parentMode?.workgroup) {
				return true
			}
		}
		return false
	}

	/**
	 * The single entry point for delegation routing. Callers (NewTaskTool,
	 * workflow delegation) never talk to delegateParentAndOpenChild directly
	 * for expert targets.
	 */
	async routeDelegation(params: RouteDelegationParams): Promise<RouteDelegationResult> {
		const { originTaskId, expertMode, message, images, initialTodos, parentModeSlug } = params

		const state = await this.deps.getState()
		const targetMode = getModeBySlug(expertMode, state.customModes)
		if (!targetMode) {
			throw new Error(`[DelegationRouter] Invalid mode: ${expertMode}`)
		}

		const useLineRouting = await this.shouldUseLineRouting(expertMode, parentModeSlug)

		if (!useLineRouting) {
			// Legacy one-shot child task; behavior unchanged for plain modes.
			const task = await this.deps.delegateAndOpenChild({
				parentTaskId: originTaskId,
				message,
				initialTodos: initialTodos ?? [],
				mode: expertMode,
				...(images ? { images } : {}),
			})
			return { task, reused: false }
		}

		const line = this.findLine(originTaskId, expertMode)

		if (!line) {
			// First delegation on this line: create it via the legacy machinery,
			// tagged with line metadata so future delegations can find it.
			const task = await this.deps.delegateAndOpenChild({
				parentTaskId: originTaskId,
				message,
				initialTodos: initialTodos ?? [],
				mode: expertMode,
				...(images ? { images } : {}),
				lineMetadata: { originTaskId, expertMode },
			})
			return { task, reused: false }
		}

		if (line.status === "active") {
			// Busy line: queue the request (Phase 4). The queue persists in the
			// line task's directory; the origin is suspended awaiting the line,
			// so under the single-open invariant this path stays rare, but the
			// protocol no longer rejects concurrent delegations.
			const queue = await this.loadQueue(line.id)
			const entry = queue.enqueue({ originTaskId, message, images })
			const taskDir = await this.deps.getTaskDirectoryPath(this.deps.globalStoragePath, line.id)
			await queue.save(taskDir)
			this.deps.log(
				`[DelegationRouter] Line ${line.id} busy; queued request ${entry.requestId} (queue depth ${queue.size()})`,
			)
			return { task: { taskId: line.id } as Task, reused: false, queued: true, requestId: entry.requestId }
		}

		// Idle line: rotate (close) it when the policy says so, then create a
		// fresh line instead of resuming. Rotation is context hygiene — the
		// expert's durable memory lives in shared files, not the session.
		if (this.shouldRotate(line)) {
			this.deps.log(
				`[DelegationRouter] Rotating line ${line.id} (${expertMode}): served=${line.lineRequestCount ?? 0} failures=${line.lineConsecutiveFailures ?? 0}`,
			)
			const task = await this.deps.delegateAndOpenChild({
				parentTaskId: originTaskId,
				message,
				initialTodos: initialTodos ?? [],
				mode: expertMode,
				...(images ? { images } : {}),
				lineMetadata: { originTaskId, expertMode },
			})
			return { task, reused: false, rotated: true }
		}

		// Idle line: resume it and append the new request as a user message.
		const task = await this.deps.resumeLineSession({
			originTaskId,
			lineHistoryItem: line,
			message,
			...(images ? { images } : {}),
		})
		return { task, reused: true }
	}
}
