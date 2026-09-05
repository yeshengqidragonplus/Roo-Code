import type { SkillsManager } from "../../../services/skills/SkillsManager"

type SkillsManagerLike = Pick<SkillsManager, "getSkillsByNames">

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;")
}

/**
 * Generate the skills section for the system prompt.
 * Only includes Skills explicitly assigned for autonomous discovery by the
 * current Mode. Explicit user slash commands are intentionally not listed.
 * Format matches the modes section style.
 *
 * @param skillsManager - The SkillsManager instance
 * @param injectedSkillNames - Mode-owned Skill names to expose to the model
 */
export async function getSkillsSection(
	skillsManager: SkillsManagerLike | undefined,
	injectedSkillNames: readonly string[] | undefined,
): Promise<string> {
	if (!skillsManager || !injectedSkillNames?.length) return ""

	const skills = skillsManager.getSkillsByNames(injectedSkillNames)
	if (skills.length === 0) return ""

	const skillsXml = skills
		.map((skill) => {
			const name = escapeXml(skill.name)
			const description = escapeXml(skill.description)
			const locationLine = `\n    <location>${escapeXml(skill.path)}</location>`
			return `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>${locationLine}\n  </skill>`
		})
		.join("\n")

	return `====

AVAILABLE SKILLS

<available_skills>
${skillsXml}
</available_skills>

<mandatory_skill_check>
REQUIRED PRECONDITION

Before producing ANY user-facing response, you MUST perform a skill applicability check.

Step 1: Skill Evaluation
- Evaluate the user's request against ALL available skill <description> entries in <available_skills>.
- Determine whether at least one skill clearly and unambiguously applies.

Step 2: Branching Decision

<if_skill_applies>
- Select the most specific Skill to load first when multiple Skills match.
- Use the skill tool to load that Skill by name.
- Load the skill's instructions fully into context BEFORE continuing.
- Follow the skill instructions precisely.
- Re-evaluate whether another available Skill is needed after completing the loaded Skill's relevant steps.
- Do NOT respond outside the applicable skill-defined flow.
</if_skill_applies>

<if_no_skill_applies>
- Proceed with a normal response.
- Do NOT load any SKILL.md files.
</if_no_skill_applies>

CONSTRAINTS:
- Do NOT load every skill up front.
- Load skills ONLY after a skill is selected.
- Do NOT reload a skill whose instructions already appear in this conversation.
- Do NOT skip this check.
- FAILURE to perform this check is an error.
</mandatory_skill_check>

<linked_file_handling>
- When a skill is loaded, ONLY the skill instructions are present.
- Files linked from the skill are NOT loaded automatically.
- The model MUST explicitly decide to read a linked file based on task relevance.
- Do NOT assume the contents of linked files unless they have been explicitly read.
- Prefer reading the minimum necessary linked file.
- Avoid reading multiple linked files unless required.
- Treat linked files as progressive disclosure, not mandatory context.
</linked_file_handling>

<context_notes>
- This list is the complete set of Skills this Mode may load autonomously.
- A Skill unavailable here may still be explicitly invoked by the user through a slash command.
</context_notes>

<internal_verification>
This section is for internal control only.
Do NOT include this section in user-facing output.

After completing the evaluation, internally confirm:
<skill_check_completed>true|false</skill_check_completed>
</internal_verification>
`
}
