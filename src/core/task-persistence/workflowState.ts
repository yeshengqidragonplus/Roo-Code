import * as path from "path"
import * as fs from "fs/promises"

import type { WorkflowState } from "@roo-code/types"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { fileExistsAtPath } from "../../utils/fs"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

/**
 * Per-session workflow state for a type-A (workflow) expert. Stored in the
 * task directory alongside ui_messages/api_conversation_history so it shares
 * the conversation's lifecycle and can be resumed whenever the task reopens.
 * `engineState` is the engine's opaque, serializable WorkflowState; `workflowId`
 * records which workflow to reload on resume.
 */
export interface PersistedWorkflowState {
	workflowId: string
	engineState: WorkflowState
	lastUpdated: number
	/**
	 * Phase 2 transient marker: set when the host has spawned a sub-expert for a
	 * workflow `delegate` action and disposed the parent. On reopen the host
	 * reads this to know it must `advance()` the workflow with the child's
	 * summary (rather than just continuing an in-flight soft step). `saveWorkflowState`
	 * intentionally omits this field, so the next `advance` persist clears it.
	 */
	pendingDelegation?: { expert: string }
}

export type ReadWorkflowStateOptions = {
	taskId: string
	globalStoragePath: string
}

/** Read the persisted workflow state for a task, or undefined if none/invalid. */
export async function readWorkflowState({
	taskId,
	globalStoragePath,
}: ReadWorkflowStateOptions): Promise<PersistedWorkflowState | undefined> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.workflowState)

	if (!(await fileExistsAtPath(filePath))) {
		return undefined
	}

	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8"))
		if (!parsed || typeof parsed !== "object" || typeof parsed.workflowId !== "string") {
			console.warn(`[readWorkflowState] Malformed workflow state for task ${taskId}, ignoring. Path: ${filePath}`)
			return undefined
		}
		return parsed as PersistedWorkflowState
	} catch (error) {
		console.warn(
			`[readWorkflowState] Failed to parse ${filePath} for task ${taskId}, ignoring: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
		return undefined
	}
}

export type SaveWorkflowStateOptions = {
	taskId: string
	globalStoragePath: string
	workflowId: string
	engineState: WorkflowState
	now: number
}

/**
 * Persist the workflow state for a task (called each workflow step). Writes only
 * the base fields — any `pendingDelegation` marker is intentionally dropped, so a
 * fresh `advance` after a delegation return clears the marker automatically.
 */
export async function saveWorkflowState({
	taskId,
	globalStoragePath,
	workflowId,
	engineState,
	now,
}: SaveWorkflowStateOptions): Promise<void> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.workflowState)
	const record: PersistedWorkflowState = { workflowId, engineState, lastUpdated: now }
	await safeWriteJson(filePath, record)
}

/**
 * Mark that the host has delegated for a workflow `delegate` action and is about
 * to dispose the parent. Read-modify-write so the engine state already persisted
 * by the triggering `advance` is preserved. Must be called AFTER that `advance`.
 */
export async function markWorkflowPendingDelegation({
	taskId,
	globalStoragePath,
	expert,
}: ReadWorkflowStateOptions & { expert: string }): Promise<void> {
	const existing = await readWorkflowState({ taskId, globalStoragePath })
	if (!existing) {
		console.warn(`[markWorkflowPendingDelegation] No workflow state for task ${taskId}; cannot mark delegation.`)
		return
	}
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.workflowState)
	const record: PersistedWorkflowState = { ...existing, pendingDelegation: { expert } }
	await safeWriteJson(filePath, record)
}

/** Clear the pendingDelegation marker (idempotent; no-op if absent). */
export async function clearWorkflowPendingDelegation({
	taskId,
	globalStoragePath,
}: ReadWorkflowStateOptions): Promise<void> {
	const existing = await readWorkflowState({ taskId, globalStoragePath })
	if (!existing || !existing.pendingDelegation) {
		return
	}
	const { pendingDelegation: _drop, ...rest } = existing
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.workflowState)
	await safeWriteJson(filePath, rest)
}
