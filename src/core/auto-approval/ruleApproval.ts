import path from "path"

import { looksLikeForcePush } from "./index"
import type { CommandReviewSnapshot } from "./reviewer"

export type RuleAssessment = { allowed: boolean; reason: string; itemIds: string[] }

// These are conservative signals, not a shell parser or a security boundary.
const dangerous =
	/(?:^|[\s;&|()])(?:rm|rmdir|unlink|del|erase|rd|remove-item|clear-content|format|diskpart|sudo|su|runas|chmod|chown|icacls|takeown)(?=$|[\s;&|()])/i
const dangerousGit =
	/\bgit(?:\.exe)?\b[^;&|\r\n]*\b(?:reset|clean|rebase)\b[^;&|\r\n]*(?:--hard|--force|\s-[a-z]*f[a-z]*(?=\s|$))/i
const dynamicSyntax =
	/[`$%*?<>]|\b(?:eval|exec|invoke-expression|iex|source|import|require|__import__|open|fetch|curl|wget)\b/i

/** Only a narrow statically understood subset can pass without isolation. */
export function assessRuleCommand(
	snapshot: CommandReviewSnapshot | undefined,
	projectRoot: string,
	isProtected: (relativePath: string) => boolean,
): RuleAssessment {
	const wait = (reason: string): RuleAssessment => ({ allowed: false, reason, itemIds: [] })
	if (!snapshot || snapshot.autoApprovalBlockedReason)
		return wait(snapshot?.autoApprovalBlockedReason ?? "无法获取完整命令与脚本，请人工检查。")
	const cwdRelative = path.relative(projectRoot, snapshot.cwdRealPath)
	if (
		cwdRelative === ".." ||
		cwdRelative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(cwdRelative) ||
		(cwdRelative && isProtected(path.join(cwdRelative, "__qcode_check__")))
	)
		return wait("工作目录位于项目外或受保护路径，请人工检查。")
	const items = snapshot.reviewItems ?? []
	if (!items.length || !items.some((item) => item.kind === "command")) return wait("无法完整拆分命令，请人工检查。")
	const allText = [
		snapshot.command,
		...items.map((item) => item.text ?? ""),
		...(snapshot.scripts ?? []).map((script) => script.source),
	].join("\n")
	if (looksLikeForcePush(allText) || dangerous.test(allText) || dangerousGit.test(allText))
		return wait("命令或脚本命中危险操作规则，请人工检查。")
	if (dynamicSyntax.test(allText))
		return wait("命令或脚本包含动态执行、路径展开、重定向或外部依赖，无法确认影响范围。")
	for (const script of snapshot.scripts ?? []) {
		const relative = path.relative(projectRoot, script.scriptPath)
		if (
			!relative ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative) ||
			isProtected(relative)
		) {
			return wait("脚本位于项目外或受保护路径，请人工检查。")
		}
		// No filesystem/network access, imports or other statements in this subset.
		const literal = `(?:'[^'\\\\\\r\\n]*'|"[^"\\\\\\r\\n]*"|[0-9]+)`
		const python = new RegExp(`^\\s*print\\(\\s*${literal}\\s*\\)\\s*;?\\s*$`)
		const javascript = new RegExp(`^\\s*console\\.log\\(\\s*${literal}\\s*\\)\\s*;?\\s*$`)
		if (!(script.scriptPath.toLowerCase().endsWith(".py") ? python : javascript).test(script.source)) {
			return wait("脚本行为或依赖无法静态确认，请人工检查。")
		}
	}
	for (const item of items.filter((entry) => entry.kind === "command")) {
		const text = (item.text ?? "").trim()
		const pathFree =
			/^(?:pwd|whoami|(?:python(?:3)?|node|git)(?:\.exe)?\s+--version|echo(?:\s+[a-z0-9_. -]+)?)$/i.test(text)
		const scriptCall =
			/^(?:python(?:3)?|node)(?:\.exe)?\s+[a-z0-9_.\/\\-]+\.(?:py|js|mjs|cjs)$/i.test(text) &&
			(snapshot.scripts?.length ?? 0) > 0
		if (!pathFree && !scriptCall) return wait("命令路径或行为无法可靠确认，请人工检查。")
	}
	return { allowed: true, reason: "通过保守的路径和危险操作检查。", itemIds: items.map((item) => item.id) }
}

/** One exact JSON response, bound to the current command and every review item. */
export function parseCommandSafetyScore(
	text: string,
	command: string,
	itemIds: string[],
	minimum: number,
): { allowed: boolean; reason: string } {
	try {
		const value: unknown = JSON.parse(text.trim())
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
		const record = value as Record<string, unknown>
		if (
			Object.keys(record).sort().join(",") !== "command,items" ||
			record.command !== command ||
			!Array.isArray(record.items) ||
			record.items.length !== itemIds.length ||
			!Number.isInteger(minimum) ||
			minimum < 0 ||
			minimum > 2
		)
			throw new Error()
		const seen = new Set<string>()
		for (const value of record.items) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
			const item = value as Record<string, unknown>
			if (
				Object.keys(item).sort().join(",") !== "decision,id,reason,safetyScore" ||
				typeof item.id !== "string" ||
				!itemIds.includes(item.id) ||
				seen.has(item.id) ||
				!Number.isInteger(item.safetyScore) ||
				(item.safetyScore as number) < 0 ||
				(item.safetyScore as number) > 2 ||
				!["allow", "wait"].includes(item.decision as string) ||
				typeof item.reason !== "string" ||
				!item.reason.trim()
			)
				throw new Error()
			seen.add(item.id)
			if (item.decision !== "allow" || (item.safetyScore as number) < minimum)
				return { allowed: false, reason: `${item.id} 评分 ${item.safetyScore}：${item.reason}` }
		}
		return { allowed: true, reason: `所有项目评分均达到 ${minimum} 分。` }
	} catch {
		return { allowed: false, reason: "模型评分缺失、格式错误或与当前命令不匹配，请人工检查。" }
	}
}
