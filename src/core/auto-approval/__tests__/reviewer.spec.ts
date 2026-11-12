import fs from "fs/promises"
import os from "os"
import path from "path"
import {
	isCommandSnapshotUnchanged,
	isSelfContainedReviewableCommand,
	parseReviewerChoice,
	prepareCommandReview,
	reviewFollowupChoice,
	reviewInlineCommand,
	withReviewerTimeout,
} from "../reviewer"

describe("reviewer follow-up choices", () => {
	const suggestions = [{ answer: "One" }, { answer: "Two" }]
	it("accepts only a valid indexed JSON decision", () => {
		expect(parseReviewerChoice('{"choice":1}', suggestions)).toBe("Two")
		for (const value of ['{"choice":-1}', '{"choice":2}', '{"choice":"1"}', '{"choice":0,"extra":true}', "One"]) {
			expect(parseReviewerChoice(value, suggestions)).toBeUndefined()
		}
	})
	it("passes the question and exact choices to the reviewer and returns the selected answer", async () => {
		const createMessage = vi.fn(async function* () {
			yield { type: "text" as const, text: '{"choice":0}' }
		})
		const result = await reviewFollowupChoice(
			{ createMessage } as never,
			{ roleDefinition: "Review decisions" } as never,
			"task",
			"Which?",
			suggestions,
			"Build UI",
		)
		expect(result).toBe("One")
		expect(JSON.stringify(createMessage.mock.calls)).toContain("Which?")
	})
	it("waits for the user if the reviewer does not respond in time", async () => {
		vi.useFakeTimers()
		try {
			const pending = withReviewerTimeout(new Promise<string>(() => {}), 100)
			await vi.advanceTimersByTimeAsync(100)
			expect(await pending).toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("command review", () => {
	it("limits the self-contained inline fast path", () => {
		for (const command of [
			"python script.py",
			"npm run build",
			'node -e "require(1)"',
			'python -c "print($HOME)"',
			"python -c 'import os'",
		]) {
			expect(isSelfContainedReviewableCommand(command)).toBe(false)
		}
		expect(isSelfContainedReviewableCommand("python -c 'print(42)' ")).toBe(true)
		expect(isSelfContainedReviewableCommand("pwsh -NoProfile -Command 'Write-Output hello'")).toBe(true)
		expect(isSelfContainedReviewableCommand("pwsh -Command 'Invoke-Expression text'")).toBe(false)
	})
	it("accepts only a precise allow response", async () => {
		const createMessage = vi.fn(async function* () {
			yield { type: "text" as const, text: '{"decision":"allow","reason":"仅输出数字"}' }
		})
		expect(
			await reviewInlineCommand(
				{ createMessage } as never,
				{ roleDefinition: "Review" } as never,
				"task",
				"python -c 'print(42)'",
				"/project",
				"test",
			),
		).toEqual({ decision: "allow", reason: "仅输出数字" })
		expect(
			await reviewInlineCommand(
				{ createMessage } as never,
				{ roleDefinition: "Review" } as never,
				"task",
				"python script.py",
				"/project",
				"test",
			),
		).toMatchObject({ decision: "wait" })
		expect(createMessage).toHaveBeenCalledTimes(1)
	})
	it("requires a reason and fails closed on malformed or missing decisions", async () => {
		for (const text of [
			'{"decision":"allow"}',
			'{"decision":"allow","reason":""}',
			"yes",
			'{"decision":"allow","reason":"ok","extra":true}',
		]) {
			const api = {
				createMessage: vi.fn(async function* () {
					yield { type: "text" as const, text }
				}),
			}
			expect(
				(
					await reviewInlineCommand(
						api as never,
						{ roleDefinition: "Review" } as never,
						"task",
						"python -c 'print(42)'",
						"/project",
						"test",
					)
				).decision,
			).toBe("wait")
		}
	})
	it("captures a project script and detects changes before approval", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-review-"))
		try {
			await fs.writeFile(path.join(dir, "task.py"), "print(42)")
			await fs.writeFile(path.join(dir, "task.ps1"), "Write-Output hello")
			await fs.writeFile(path.join(dir, "task.sh"), "echo hello")
			await fs.writeFile(path.join(dir, "task.bat"), "echo hello")
			expect((await prepareCommandReview("bash task.sh", dir, dir))?.requiresHuman).toBe(true)
			expect((await prepareCommandReview("cmd /c task.bat", dir, dir))?.requiresHuman).toBe(true)
			expect((await prepareCommandReview("pwsh -File task.ps1", dir, dir))?.source).toBe("Write-Output hello")
			const snapshot = await prepareCommandReview("python task.py", dir, dir)
			expect((await prepareCommandReview("python task.py --output result", dir, dir))?.requiresHuman).toBe(true)
			expect(snapshot?.source).toBe("print(42)")
			expect(await isCommandSnapshotUnchanged(snapshot!)).toBe(true)
			await fs.writeFile(path.join(dir, "task.py"), "print(43)")
			expect(await isCommandSnapshotUnchanged(snapshot!)).toBe(false)
			await fs.writeFile(path.join(dir, "task.py"), "import os\nprint(1)")
			const dependent = await prepareCommandReview("python task.py", dir, dir)
			expect(dependent?.source).toContain("import os")
			expect(dependent?.requiresHuman).toBe(true)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
