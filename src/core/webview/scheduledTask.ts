export interface ScheduledTask {
	id: string
	dueAt: number
	text: string
	images?: string[]
	mode: string
	/** Absent for records created by older versions (a new task). */
	taskId?: string
	/** If scheduled while waiting for a response, never answer a different question. */
	askTs?: number
	apiConfigName?: string
	reviewerChoiceEnabled: boolean
	status: "pending" | "started" | "missed" | "failed"
	error?: string
}

interface ScheduleDeps {
	load(): ScheduledTask | undefined
	save(task: ScheduledTask | undefined): Promise<void>
	claim(id: string): Promise<boolean>
	execute(task: ScheduledTask): Promise<void>
	notify(task: ScheduledTask): void
	now(): number
}

/** One workspace-local scheduled start; missed jobs never run late by surprise. */
export class ScheduledTaskService {
	private timer?: ReturnType<typeof setTimeout>
	constructor(private readonly deps: ScheduleDeps) {}

	async schedule(task: ScheduledTask): Promise<void> {
		if (!Number.isFinite(task.dueAt) || task.dueAt <= this.deps.now())
			throw new Error("Scheduled time must be in the future")
		if (this.deps.load()?.status === "pending") throw new Error("A scheduled task is already pending")
		await this.deps.save(task)
		this.arm()
	}

	async cancel(): Promise<void> {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		await this.deps.save(undefined)
	}

	arm(): void {
		if (this.timer) clearTimeout(this.timer)
		const task = this.deps.load()
		if (!task || task.status !== "pending") return
		const delay = Math.min(Math.max(task.dueAt - this.deps.now(), 0), 2_147_000_000)
		this.timer = setTimeout(() => {
			void this.run(task.id)
		}, delay)
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer)
	}

	private async run(id: string): Promise<void> {
		let task = this.deps.load()
		if (!task || task.id !== id || task.status !== "pending") return
		if (task.dueAt > this.deps.now()) return this.arm()
		try {
			if (this.deps.now() - task.dueAt > 120_000) {
				task = { ...task, status: "missed", error: "启动时间已错过，未自动执行" }
			} else if (await this.deps.claim(id)) {
				const current = this.deps.load()
				if (!current || current.id !== id || current.status !== "pending") return
				task = { ...current, status: "started" }
				await this.deps.save(task)
				if (this.deps.load()?.id !== id || this.deps.load()?.status !== "started") return
				await this.deps.execute(task)
			} else {
				return
			}
		} catch (error) {
			task = { ...task, status: "failed", error: error instanceof Error ? error.message : String(error) }
		}
		if (this.deps.load()?.id !== id) return
		await this.deps.save(task)
		this.deps.notify(task)
	}
}
