import fs from "fs/promises"
import os from "os"
import path from "path"
import {
	isCommandSnapshotUnchanged,
	isSelfContainedReviewableCommand,
	parseReviewerChoice,
	prepareCommandReview,
	prepareReviewerEvidence,
	reviewFollowupChoice,
	reviewInlineCommand,
	withReviewerTimeout,
	explainReviewerFailure,
	explainCommandReviewUnavailable,
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
	it("describes known connection failures without exposing provider details", () => {
		expect(explainReviewerFailure({ status: 429, message: "secret" })).toContain("429")
		expect(explainReviewerFailure({ code: "ENOTFOUND" })).toContain("ENOTFOUND")
		expect(explainReviewerFailure({ message: "secret" })).not.toContain("secret")
	})
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
		expect(isSelfContainedReviewableCommand('powershell -Command "python tools/task.py"')).toBe(false)
		expect(
			isSelfContainedReviewableCommand('powershell -Command "Write-Output hello; Remove-Item important"'),
		).toBe(false)
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
		).toMatchObject({ decision: "allow" })
		expect(createMessage).toHaveBeenCalledTimes(2)
	})

	it("reviews ordinary commands and marks uncaptured scripts as ineligible for automatic execution", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-review-evidence-"))
		try {
			const ordinary = await prepareReviewerEvidence("python --version", dir, dir)
			expect(ordinary?.command).toBe("python --version")
			expect(ordinary?.autoApprovalBlockedReason).toBeUndefined()
			const missing = await prepareReviewerEvidence("python missing.py --value 1", dir, dir)
			expect(missing?.autoApprovalBlockedReason).toContain("未能安全读取")
			const missingQuoted = await prepareReviewerEvidence('python "missing file.py"', dir, dir)
			expect(missingQuoted?.autoApprovalBlockedReason).toContain("未能安全读取")
			expect((await prepareReviewerEvidence("py missing.py", dir, dir))?.autoApprovalBlockedReason).toContain(
				"未能安全读取",
			)
			expect(
				(await prepareReviewerEvidence('"missing file.ps1"', dir, dir))?.autoApprovalBlockedReason,
			).toContain("未能安全读取")
			const outside = await prepareReviewerEvidence("python --version", os.tmpdir(), dir)
			expect(outside?.autoApprovalBlockedReason).toContain("项目外")
			const unavailableCwd = await prepareReviewerEvidence("python --version", path.join(dir, "not-found"), dir)
			expect(unavailableCwd?.autoApprovalBlockedReason).toContain("无法解析")
			const createMessage = vi.fn(async function* () {
				yield { type: "text" as const, text: '{"decision":"wait","reason":"脚本内容不可见"}' }
			})
			const result = await reviewInlineCommand(
				{ createMessage } as never,
				{ roleDefinition: "Review" } as never,
				"task",
				"python missing.py --value 1",
				dir,
				"test",
				missing,
			)
			expect(result.reason).toContain("脚本内容不可见")
			expect(JSON.stringify(createMessage.mock.calls)).toContain("python missing.py --value 1")
			await fs.writeFile(path.join(dir, "task.py"), "import os\nprint(1)")
			const withArgs = await prepareReviewerEvidence("python task.py --output result", dir, dir)
			expect(withArgs?.source).toContain("import os")
			expect(withArgs?.autoApprovalBlockedReason).toBeUndefined()
			expect(withArgs?.requiresHuman).toBe(true)
			const multiple = await prepareReviewerEvidence("python task.py; python other.py", dir, dir)
			expect(multiple?.autoApprovalBlockedReason).toContain("未能安全读取")
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("shows a bounded model response when its decision format is invalid", async () => {
		const api = {
			createMessage: vi.fn(async function* () {
				yield { type: "text" as const, text: "不确定这条命令" }
			}),
		}
		const result = await reviewInlineCommand(
			api as never,
			{ roleDefinition: "Review" } as never,
			"task",
			"python --version",
			"/project",
			"test",
		)
		expect(result.decision).toBe("wait")
		expect(result.reason).toContain("不确定这条命令")
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
			await fs.writeFile(path.join(dir, "dependent.ps1"), "python other.py")
			expect((await prepareCommandReview("pwsh -File dependent.ps1", dir, dir))?.requiresHuman).toBe(true)
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

	it("sends PowerShell pipeline variables for advice only, never as a trusted snapshot", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-review-pwsh-"))
		try {
			const command = `powershell -NoProfile -Command "Select-String -Path 'notes.txt' -Pattern 'key' | Select-Object -First 40 | ForEach-Object { $_.Line }"`
			const snapshot = await prepareCommandReview(command, dir, dir)
			expect(snapshot?.requiresHuman).toBe(true)
			expect(snapshot?.source).toContain("$_.Line")
			expect(snapshot?.manualReviewReason).toContain("外层 shell")
			const createMessage = vi.fn(async function* () {
				yield { type: "text" as const, text: '{"decision":"allow","reason":"读取文件"}' }
			})
			await reviewInlineCommand(
				{ createMessage } as never,
				{ roleDefinition: "Review" } as never,
				"task",
				command,
				dir,
				"test",
				snapshot,
			)
			expect(JSON.stringify(createMessage.mock.calls)).toContain("$_.Line")
			expect(JSON.stringify(createMessage.mock.calls)).toContain("dependenciesFullyVisible")
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("captures only a project-local candidate referenced by a PowerShell wrapper", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-review-wrapper-"))
		try {
			await fs.mkdir(path.join(dir, "tools"))
			await fs.writeFile(path.join(dir, "tools", "task.py"), "print('safe test')")
			const command = `powershell -NoProfile -Command "$env:PYTHONUTF8='1'; python tools/task.py"`
			const snapshot = await prepareCommandReview(command, dir, dir)
			expect(snapshot?.requiresHuman).toBe(true)
			expect(snapshot?.inlineSource).toContain("$env:PYTHONUTF8")
			expect(snapshot?.source).toContain("safe test")
			expect(snapshot?.scriptPath).toBe(await fs.realpath(path.join(dir, "tools", "task.py")))
			expect(snapshot?.manualReviewReason).toContain("候选脚本")
			const external = await prepareCommandReview(`powershell -Command "python ../outside.py"`, dir, dir)
			expect(external?.requiresHuman).toBe(true)
			expect(external?.scriptPath).toBeUndefined()
			expect(external?.manualReviewReason).toContain("未能安全读取")
			expect(await explainCommandReviewUnavailable("npm test", dir, dir)).toContain("格式")
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
