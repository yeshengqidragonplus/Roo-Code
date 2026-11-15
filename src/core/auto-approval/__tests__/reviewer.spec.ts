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
	it("reports why script capture failed without exposing command, paths, or error messages", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-review-diag-"))
		try {
			const report = vi.fn()
			await prepareReviewerEvidence("python missing.py", dir, dir, undefined, report)
			expect(report).toHaveBeenCalledWith({ stage: "script", reason: "filesystem_error", errorCode: "ENOENT" })
			report.mockClear()
			await prepareReviewerEvidence("python task.py > output.log", dir, dir, undefined, report)
			expect(report).toHaveBeenCalledWith({ stage: "script", reason: "filesystem_error", errorCode: "ENOENT" })
			report.mockClear()
			await prepareReviewerEvidence(
				'powershell -Command "python task.py > output.log"',
				dir,
				dir,
				undefined,
				report,
			)
			expect(report).toHaveBeenCalledWith({ stage: "script", reason: "filesystem_error", errorCode: "ENOENT" })
			await fs.writeFile(path.join(dir, "task.py"), "print(1)")
			const read = vi
				.spyOn(fs, "readFile")
				.mockRejectedValue(Object.assign(new Error("private path and token"), { code: "EACCES" }))
			report.mockClear()
			await prepareReviewerEvidence("python task.py", dir, dir, undefined, report)
			expect(report).toHaveBeenCalledWith({ stage: "script", reason: "filesystem_error", errorCode: "EACCES" })
			expect(JSON.stringify(report.mock.calls)).not.toContain(dir)
			expect(JSON.stringify(report.mock.calls)).not.toContain("private path and token")
			read.mockRestore()
			await fs.writeFile(path.join(dir, "large.py"), "x".repeat(256 * 1024 + 1))
			report.mockClear()
			await prepareReviewerEvidence("python large.py", dir, dir, undefined, report)
			expect(report).toHaveBeenCalledWith({ stage: "script", reason: "file_too_large" })
		} finally {
			vi.restoreAllMocks()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
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

	it("captures every script in a command chain and checks every file again", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qcode-review-multi-"))
		try {
			await fs.mkdir(path.join(dir, "tools"))
			await fs.writeFile(path.join(dir, "tools", "first.py"), "print('first')")
			await fs.writeFile(path.join(dir, "tools", "second.py"), "print('second')")
			const command = 'python tools/first.py > result.log && python "tools/second.py" --flag'
			const snapshot = await prepareReviewerEvidence(command, dir, dir)
			expect(snapshot?.autoApprovalBlockedReason).toBeUndefined()
			expect(snapshot?.scripts?.map((script) => script.source)).toEqual(["print('first')", "print('second')"])
			expect(snapshot?.reviewItems?.map((item) => item.id)).toEqual([
				"command-1",
				"script-1",
				"command-2",
				"script-2",
			])
			const createMessage = vi.fn(async function* (_system: string, messages: any[]) {
				const payload = JSON.parse(messages[0].content[0].text)
				expect(payload.scripts.map((script: { source: string }) => script.source)).toEqual([
					"print('first')",
					"print('second')",
				])
				yield {
					type: "text" as const,
					text: JSON.stringify({
						items: payload.reviewItems.map((item: { id: string }) => ({
							id: item.id,
							decision: "allow",
							reason: "已检查",
						})),
					}),
				}
			})
			const result = await reviewInlineCommand(
				{ createMessage } as never,
				{ roleDefinition: "Review" } as never,
				"task",
				command,
				dir,
				"test",
				snapshot,
			)
			expect(result.decision).toBe("allow")
			expect(result.reason).toContain("命令 2")
			expect(result.reason).toContain("脚本 2")
			const wrapped = await prepareReviewerEvidence(
				'powershell -Command "python tools/first.py > result.log; python tools/second.py"',
				dir,
				dir,
			)
			expect(wrapped?.autoApprovalBlockedReason).toBeUndefined()
			expect(wrapped?.scripts?.map((script) => script.source)).toEqual(["print('first')", "print('second')"])
			expect(await isCommandSnapshotUnchanged(snapshot!)).toBe(true)
			await fs.writeFile(path.join(dir, "tools", "second.py"), "print('changed')")
			expect(await isCommandSnapshotUnchanged(snapshot!)).toBe(false)
			const changedDir = await prepareReviewerEvidence("cd tools && python first.py", dir, dir)
			expect(changedDir?.autoApprovalBlockedReason).toContain("改变工作目录")
			const partiallyMissing = await prepareReviewerEvidence(
				"python absent.py && python tools/first.py",
				dir,
				dir,
			)
			expect(partiallyMissing?.autoApprovalBlockedReason).toContain("未能安全读取")
			expect(partiallyMissing?.reviewItems?.map((item) => item.id)).toEqual([
				"command-1",
				"script-1",
				"command-2",
				"script-2",
			])
			expect(partiallyMissing?.reviewItems?.find((item) => item.id === "script-1")?.text).toContain("无法读取")
			expect(partiallyMissing?.scripts?.[0]?.id).toBe("script-2")
			const indirect = await prepareReviewerEvidence(`python -c "exec(open('tools/first.py').read())"`, dir, dir)
			expect(indirect?.autoApprovalBlockedReason).toContain("间接引用")
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("requires an explicit decision and reason for every command and script", async () => {
		const items = [
			{ id: "command-1", kind: "command" as const, label: "命令 1" },
			{ id: "script-1", kind: "script" as const, label: "脚本 1" },
			{ id: "command-2", kind: "command" as const, label: "命令 2" },
		]
		const snapshot = {
			command: "test",
			cwd: "/project",
			cwdRealPath: "/project",
			reviewItems: items,
			scripts: [
				{
					scriptPath: "/project/test.py",
					scriptInputPath: "/project/test.py",
					source: "print(42)",
					sha256: "abc",
				},
			],
		}
		const invoke = async (reply: unknown) => {
			const createMessage = vi.fn(async function* () {
				yield { type: "text" as const, text: JSON.stringify(reply) }
			})
			const result = await reviewInlineCommand(
				{ createMessage } as never,
				{ roleDefinition: "Review" } as never,
				"task",
				"test",
				"/project",
				"test",
				snapshot,
			)
			expect(JSON.stringify(createMessage.mock.calls)).toContain("print(42)")
			return result
		}
		const accepted = items.map((item) => ({ id: item.id, decision: "allow", reason: "已检查" }))
		expect((await invoke({ items: accepted })).decision).toBe("allow")
		const withWait = accepted.map((item, i) =>
			i === 1 ? { ...item, decision: "wait", reason: "脚本可能联网" } : item,
		)
		const waiting = await invoke({ items: withWait })
		expect(waiting.decision).toBe("wait")
		expect(waiting.reason).toContain("脚本可能联网")
		const multipleWait = withWait.map((item, i) =>
			i === 2 ? { ...item, decision: "wait", reason: "输出会覆盖文件" } : item,
		)
		const multipleReasons = await invoke({ items: multipleWait })
		expect(multipleReasons.decision).toBe("wait")
		expect(multipleReasons.reason).toContain("脚本可能联网")
		expect(multipleReasons.reason).toContain("输出会覆盖文件")
		expect((await invoke({ items: accepted.slice(0, 2) })).decision).toBe("wait")
		expect((await invoke({ items: [accepted[0], accepted[0], accepted[2]] })).decision).toBe("wait")
		expect((await invoke({ decision: "allow", reason: "忽略单项" })).decision).toBe("wait")
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
