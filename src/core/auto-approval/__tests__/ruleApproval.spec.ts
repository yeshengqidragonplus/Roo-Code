import path from "path"
import { assessRuleCommand, parseCommandSafetyScore } from "../ruleApproval"
import type { CommandReviewSnapshot } from "../reviewer"

const root = path.resolve("project")
function snapshot(command: string, source?: string): CommandReviewSnapshot {
	return {
		command,
		cwd: root,
		cwdRealPath: root,
		reviewItems: [
			{ id: "command-1", kind: "command", label: "command", text: command },
			...(source ? [{ id: "script-1", kind: "script" as const, label: "script", text: "captured" }] : []),
		],
		scripts: source
			? [
					{
						id: "script-1",
						scriptPath: path.join(root, "safe.py"),
						scriptInputPath: path.join(root, "safe.py"),
						source,
						sha256: "test",
					},
				]
			: [],
	}
}

describe("third-tier command rules", () => {
	it.each([
		"git push --force",
		"git push origin +main:main",
		"rm file",
		"git reset --hard",
		"python ../outside.py",
		"python .roo/secret.py",
		"echo hello > ../outside",
		"python -c 'open(\"x\")'",
	])("requires manual approval for %s", (command) => {
		expect(assessRuleCommand(snapshot(command), root, () => false).allowed).toBe(false)
	})
	it("allows only understood commands and captured literal scripts", () => {
		expect(assessRuleCommand(snapshot("python --version"), root, () => false).allowed).toBe(true)
		expect(assessRuleCommand(snapshot("python safe.py", "print('hello')"), root, () => false).allowed).toBe(true)
		expect(
			assessRuleCommand(snapshot("python safe.py", "print(open('../secret').read())"), root, () => false).allowed,
		).toBe(false)
		expect(assessRuleCommand(snapshot("python safe.py", "print('hello')"), root, () => true).allowed).toBe(false)
	})
	it("never approves missing or unresolved evidence", () => {
		expect(assessRuleCommand(undefined, root, () => false).allowed).toBe(false)
		expect(
			assessRuleCommand({ ...snapshot("pwd"), autoApprovalBlockedReason: "unresolved" }, root, () => false)
				.allowed,
		).toBe(false)
	})
})

describe("command safety score", () => {
	const item = { id: "command-1", safetyScore: 2, decision: "allow", reason: "only checks version" }
	const score = (items: unknown[], command = "python --version") => JSON.stringify({ command, items })
	it("requires the current command and every item at or above the threshold", () => {
		expect(parseCommandSafetyScore(score([item]), "python --version", ["command-1"], 2).allowed).toBe(true)
		expect(
			parseCommandSafetyScore(score([{ ...item, safetyScore: 1 }]), "python --version", ["command-1"], 2).allowed,
		).toBe(false)
		expect(
			parseCommandSafetyScore(score([{ ...item, safetyScore: 1 }]), "python --version", ["command-1"], 1).allowed,
		).toBe(true)
		expect(parseCommandSafetyScore(score([item]), "python --version", ["command-1", "script-1"], 2).allowed).toBe(
			false,
		)
	})
	it("fails closed for malformed, mismatched, duplicate or contradictory answers", () => {
		for (const answer of [
			"no score",
			score([item], "other"),
			score([item, item]),
			score([{ ...item, decision: "wait" }]),
			score([{ ...item, safetyScore: 3 }]),
		]) {
			expect(parseCommandSafetyScore(answer, "python --version", ["command-1"], 2).allowed).toBe(false)
		}
	})
})
