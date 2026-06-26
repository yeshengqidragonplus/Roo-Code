import * as vscode from "vscode"

import { RooCodeEventName, type HistoryItem } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"
import { SELF_REFLECTION_PROMPT } from "../prompts/instructions/self-reflection"
import { frameWorkflowStepPrompt } from "../expert/WorkflowSession"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface AttemptCompletionParams {
	result: string
	command?: string
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

/**
 * Interface for provider methods needed by AttemptCompletionTool for delegation handling.
 */
interface DelegationProvider {
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void>
}

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		const { result } = params
		const { handleError, pushToolResult, askFinishSubTaskApproval } = callbacks

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList && task.todoList.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		try {
			if (!result) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion")
				pushToolResult(await task.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			task.consecutiveMistakeCount = 0

			// Workflow expert (type A): attempt_completion marks a per-STEP boundary, not the
			// whole task. Feed the result to the workflow; if it isn't done, show the stage
			// result and continue the loop with the next step's prompt. Only when the workflow
			// itself reports done do we fall through to real completion. (Top-level only;
			// sub-experts delegate to their parent via the parentTaskId path below.)
			if (task.workflowSession && !task.parentTaskId) {
				let nextStep: Awaited<ReturnType<typeof task.workflowSession.advance>> | undefined
				try {
					nextStep = await task.workflowSession.advance(result)
				} catch (error) {
					await task.say(
						"error",
						`Workflow step failed: ${error instanceof Error ? error.message : String(error)}`,
					)
					// Fall through to normal completion so the user isn't trapped.
				}

				if (nextStep && !nextStep.done && nextStep.delegate) {
					// Phase 2 hard delegate: hand this step off to a sub-expert. The
					// placeholder tool_result is pushed (via the callback) right before the
					// delegation disposes this task, so the in-flight attempt_completion
					// tool_use is paired and the parent's history stays well-formed across
					// the dispose/reopen. The workflow advances with the child's summary
					// when the parent reopens.
					const delegate = nextStep.delegate
					await task.say("completion_result", result, undefined, false)
					const delegated = await task.beginWorkflowDelegation(delegate, () =>
						pushToolResult(
							formatResponse.toolResult(
								`Delegating to sub-expert "${delegate.expert}": ${delegate.goal}`,
							),
						),
					)
					if (!delegated) {
						// Target expert/mode missing → degrade to a soft step for the current expert.
						pushToolResult(formatResponse.toolResult(frameWorkflowStepPrompt(delegate.goal)))
					}
					return
				}

				if (nextStep && !nextStep.done && nextStep.prompt) {
					await task.say("completion_result", result, undefined, false)
					pushToolResult(formatResponse.toolResult(frameWorkflowStepPrompt(nextStep.prompt)))
					return
				}
				// nextStep.done (or error) → fall through to the normal completion flow below.
			}

			// Optional self-evaluation: when enabled, run one reflection pass before finalizing.
			// Runs at most once per task and only for top-level tasks (subtasks delegate to their parent).
			const enableSelfReflection = (await task.providerRef.deref()?.getState())?.enableSelfReflection ?? false

			if (enableSelfReflection && !task.didSelfReflect && !task.parentTaskId) {
				task.didSelfReflect = true
				pushToolResult(formatResponse.toolResult(SELF_REFLECTION_PROMPT))
				return
			}

			await task.say("completion_result", result, undefined, false)

			// Check for subtask using parentTaskId (metadata-driven delegation)
			if (task.parentTaskId) {
				// Check if this subtask has already completed and returned to parent
				// to prevent duplicate tool_results when user revisits from history
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (provider) {
					try {
						const { historyItem } = await provider.getTaskWithId(task.taskId)
						const status = historyItem?.status

						if (status === "completed") {
							// Subtask already completed - skip delegation flow entirely
							// Fall through to normal completion ask flow below (outside this if block)
							// This shows the user the completion result and waits for acceptance
							// without injecting another tool_result to the parent
						} else if (status === "active") {
							// Normal subtask completion - do delegation
							const delegation = await this.delegateToParent(
								task,
								result,
								provider,
								askFinishSubTaskApproval,
								pushToolResult,
							)
							if (delegation === "delegated") {
								this.emitTaskCompleted(task)
							}
							if (delegation !== "continue") return
						} else {
							// Unexpected status (undefined or "delegated") - log error and skip delegation
							// undefined indicates a bug in status persistence during child creation
							// "delegated" would mean this child has its own grandchild pending (shouldn't reach attempt_completion)
							console.error(
								`[AttemptCompletionTool] Unexpected child task status "${status}" for task ${task.taskId}. ` +
									`Expected "active" or "completed". Skipping delegation to prevent data corruption.`,
							)
							// Fall through to normal completion ask flow
						}
					} catch (err) {
						// If we can't get the history, log error and skip delegation
						console.error(
							`[AttemptCompletionTool] Failed to get history for task ${task.taskId}: ${(err as Error)?.message ?? String(err)}. ` +
								`Skipping delegation.`,
						)
						// Fall through to normal completion ask flow
					}
				}
			}

			const { response, text, images } = await task.ask("completion_result", "", false)

			if (response === "yesButtonClicked") {
				this.emitTaskCompleted(task)
				return
			}

			// User provided feedback - push tool result to continue the conversation
			await task.say("user_feedback", text ?? "", images)

			const feedbackText = `<user_message>\n${text}\n</user_message>`
			pushToolResult(formatResponse.toolResult(feedbackText, images))
		} catch (error) {
			await handleError("inspecting site", error as Error)
		}
	}

	/**
	 * Handles the common delegation flow when a subtask completes.
	 * Returns:
	 * - "delegated" when completion was approved and parent resumed
	 * - "denied" when user denied finishing the subtask
	 * - "continue" when caller should fall through to normal completion ask flow
	 */
	private async delegateToParent(
		task: Task,
		result: string,
		provider: DelegationProvider,
		askFinishSubTaskApproval: () => Promise<boolean>,
		pushToolResult: (result: string) => void,
	): Promise<"delegated" | "denied" | "continue"> {
		const didApprove = await askFinishSubTaskApproval()

		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return "denied"
		}

		pushToolResult("")

		await provider.reopenParentFromDelegation({
			parentTaskId: task.parentTaskId!,
			childTaskId: task.taskId,
			completionResultSummary: result,
		})

		return "delegated"
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.say("completion_result", result ?? "", undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.say("completion_result", result ?? "", undefined, block.partial)
		}
	}

	private emitTaskCompleted(task: Task): void {
		// Force final token usage update before emitting TaskCompleted.
		// This ensures the latest stats are captured regardless of throttle timer.
		task.emitFinalTokenUsageUpdate()
		task.emit(RooCodeEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage)
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
