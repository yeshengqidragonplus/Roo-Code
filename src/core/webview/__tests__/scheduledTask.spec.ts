import { ScheduledTaskService, type ScheduledTask } from "../scheduledTask"

describe("ScheduledTaskService", () => {
	let record: ScheduledTask | undefined
	let service: ScheduledTaskService
	let execute: ReturnType<typeof vi.fn>
	let claim: ReturnType<typeof vi.fn>
	const sample = (): ScheduledTask => ({
		id: "one",
		dueAt: Date.now() + 1000,
		text: "build",
		mode: "code",
		reviewerChoiceEnabled: false,
		status: "pending",
	})
	beforeEach(() => {
		vi.useFakeTimers()
		record = undefined
		execute = vi.fn().mockResolvedValue(undefined)
		claim = vi.fn().mockResolvedValue(true)
		service = new ScheduledTaskService({
			load: () => record,
			save: async (value) => {
				record = value
			},
			execute,
			claim,
			notify: vi.fn(),
			now: Date.now,
		})
	})
	afterEach(() => {
		service.dispose()
		vi.useRealTimers()
	})
	it("starts once after the selected time", async () => {
		await service.schedule(sample())
		await vi.advanceTimersByTimeAsync(1000)
		expect(execute).toHaveBeenCalledTimes(1)
		expect(record?.status).toBe("started")
	})
	it("does not start after cancellation", async () => {
		await service.schedule(sample())
		await service.cancel()
		await vi.advanceTimersByTimeAsync(1000)
		expect(execute).not.toHaveBeenCalled()
	})
	it("does not start a missed task after restart", async () => {
		record = { ...sample(), dueAt: Date.now() - 120_001 }
		service.arm()
		await vi.advanceTimersByTimeAsync(1)
		expect(execute).not.toHaveBeenCalled()
		expect(record?.status).toBe("missed")
	})
	it("does not execute when another window already claimed the task", async () => {
		claim.mockResolvedValue(false)
		await service.schedule(sample())
		await vi.advanceTimersByTimeAsync(1000)
		expect(execute).not.toHaveBeenCalled()
	})
	it("does not start if the user cancels while the claim is in progress", async () => {
		let resolveClaim!: (value: boolean) => void
		claim.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					resolveClaim = resolve
				}),
		)
		await service.schedule(sample())
		await vi.advanceTimersByTimeAsync(1000)
		await service.cancel()
		resolveClaim(true)
		await Promise.resolve()
		await Promise.resolve()
		expect(execute).not.toHaveBeenCalled()
	})
	it("records an execution failure without retrying automatically", async () => {
		execute.mockRejectedValue(new Error("another task is active"))
		await service.schedule(sample())
		await vi.advanceTimersByTimeAsync(1000)
		expect(record?.status).toBe("failed")
		expect(record?.error).toContain("another task")
		service.arm()
		await vi.advanceTimersByTimeAsync(1000)
		expect(execute).toHaveBeenCalledTimes(1)
	})
})
