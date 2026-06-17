/**
 * @fileoverview Lightweight, opt-in memory probe for diagnosing memory growth.
 *
 * The probe is a no-op unless the `QCODE_MEMORY_PROBE` environment variable is set
 * (any non-empty value). When enabled it logs `process.memoryUsage()` deltas to an
 * output channel / console so a session's heap growth can be tracked turn-by-turn
 * against the optimizations tracked in docs/memory-optimization.md.
 *
 * Keep this dependency-free and side-effect-free when disabled so it can stay in
 * production builds at zero cost.
 */

const ENABLED = !!process.env.QCODE_MEMORY_PROBE

let lastHeapUsed = 0

function fmtMB(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * Record a memory sample tagged with a label (e.g. a task id or turn marker).
 * Extra numeric counters (message counts, history sizes) can be attached for context.
 *
 * No-op unless QCODE_MEMORY_PROBE is set.
 */
export function recordMemorySample(label: string, counters?: Record<string, number>): void {
	if (!ENABLED) {
		return
	}

	const usage = process.memoryUsage()
	const delta = lastHeapUsed === 0 ? 0 : usage.heapUsed - lastHeapUsed
	lastHeapUsed = usage.heapUsed

	const sign = delta >= 0 ? "+" : "-"
	const counterStr = counters
		? " " +
			Object.entries(counters)
				.map(([k, v]) => `${k}=${v}`)
				.join(" ")
		: ""

	console.log(
		`[memory-probe] ${label} heapUsed=${fmtMB(usage.heapUsed)} (${sign}${fmtMB(Math.abs(delta))}) ` +
			`rss=${fmtMB(usage.rss)} external=${fmtMB(usage.external)}${counterStr}`,
	)
}

/** Whether the probe is active. Useful to guard expensive counter computation. */
export const isMemoryProbeEnabled = ENABLED
