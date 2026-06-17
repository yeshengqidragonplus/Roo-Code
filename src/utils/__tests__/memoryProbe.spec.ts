// Note: memoryProbe reads QCODE_MEMORY_PROBE at module load, so each behavior is
// exercised with vi.resetModules() + a fresh dynamic import under the desired env.

describe("memoryProbe", () => {
	const ORIGINAL_ENV = process.env.QCODE_MEMORY_PROBE
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.resetModules()
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		logSpy.mockRestore()
		if (ORIGINAL_ENV === undefined) {
			delete process.env.QCODE_MEMORY_PROBE
		} else {
			process.env.QCODE_MEMORY_PROBE = ORIGINAL_ENV
		}
	})

	it("is a no-op when QCODE_MEMORY_PROBE is unset", async () => {
		delete process.env.QCODE_MEMORY_PROBE
		const { recordMemorySample, isMemoryProbeEnabled } = await import("../memoryProbe")

		expect(isMemoryProbeEnabled).toBe(false)
		recordMemorySample("test")
		expect(logSpy).not.toHaveBeenCalled()
	})

	it("logs a sample when enabled", async () => {
		process.env.QCODE_MEMORY_PROBE = "1"
		const { recordMemorySample, isMemoryProbeEnabled } = await import("../memoryProbe")

		expect(isMemoryProbeEnabled).toBe(true)
		recordMemorySample("my-label")

		expect(logSpy).toHaveBeenCalledTimes(1)
		const line = logSpy.mock.calls[0][0] as string
		expect(line).toContain("[memory-probe]")
		expect(line).toContain("my-label")
		expect(line).toContain("heapUsed=")
	})

	it("includes provided counters in the log line", async () => {
		process.env.QCODE_MEMORY_PROBE = "1"
		const { recordMemorySample } = await import("../memoryProbe")

		recordMemorySample("turn", { apiHistory: 42, clineMessages: 7 })

		const line = logSpy.mock.calls[0][0] as string
		expect(line).toContain("apiHistory=42")
		expect(line).toContain("clineMessages=7")
	})
})
