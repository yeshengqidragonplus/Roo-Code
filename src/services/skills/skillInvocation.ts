import type { SkillContent } from "../../shared/skills"

export interface SkillLookup {
	getSkillContent(name: string, currentMode?: string): Promise<SkillContent | null>
	getSkillContentForSlashCommand?(name: string): Promise<SkillContent | null>
	getAssignedSkillContent?(name: string, assignedSkillNames: readonly string[]): Promise<SkillContent | null>
}

/** Resolve a user-explicit slash command, independent of Mode Skill injection. */
export async function resolveSkillContentForSlashCommand(
	skillsManager: SkillLookup | undefined,
	skillName: string,
): Promise<SkillContent | null> {
	if (!skillsManager) return null

	return skillsManager.getSkillContentForSlashCommand
		? skillsManager.getSkillContentForSlashCommand(skillName)
		: skillsManager.getSkillContent(skillName)
}

/** Resolve a Skill that the active Mode has explicitly exposed to the model. */
export async function resolveSkillContentForMode(
	skillsManager: SkillLookup | undefined,
	skillName: string,
	assignedSkillNames: readonly string[],
): Promise<SkillContent | null> {
	if (!skillsManager || !assignedSkillNames.includes(skillName)) return null

	return skillsManager.getAssignedSkillContent
		? skillsManager.getAssignedSkillContent(skillName, assignedSkillNames)
		: skillsManager.getSkillContent(skillName)
}

type SkillContentForFormatting = Pick<SkillContent, "source" | "description" | "instructions">

export function buildSkillApprovalMessage(
	skillName: string,
	args: string | undefined,
	skillContent: Pick<SkillContent, "source" | "description">,
): string {
	return JSON.stringify({
		tool: "skill",
		skill: skillName,
		args,
		source: skillContent.source,
		description: skillContent.description,
	})
}

export function buildSkillResult(
	skillName: string,
	args: string | undefined,
	skillContent: SkillContentForFormatting,
): string {
	let result = `Skill: ${skillName}`

	if (skillContent.description) {
		result += `\nDescription: ${skillContent.description}`
	}

	if (args) {
		result += `\nProvided arguments: ${args}`
	}

	result += `\nSource: ${skillContent.source}`
	result += `\n\n--- Skill Instructions ---\n\n${skillContent.instructions}`

	return result
}
