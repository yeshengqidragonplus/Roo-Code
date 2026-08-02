import * as vscode from "vscode"

import type { ModeConfig } from "@roo-code/types"

import { getAllModesWithPrompts, getModeBySlug } from "../../../shared/modes"
import { ensureSettingsDirectoryExists } from "../../../utils/globalContext"

export async function getModesSection(
	context: vscode.ExtensionContext,
	runtimeModeSlug?: string,
	customModes?: ModeConfig[],
): Promise<string> {
	// Make sure path gets created
	await ensureSettingsDirectoryExists(context)

	// Get all modes with their overrides from extension state
	const allModes = await getAllModesWithPrompts(context)
	const runtimeMode = runtimeModeSlug ? getModeBySlug(runtimeModeSlug, customModes) : undefined

	// A workgroup must expose only its own colleagues. The global mode registry
	// is intentionally shared by a project, but loading every specialist into a
	// lead's prompt defeats progressive capability expansion and misleads it into
	// attempting invalid delegations.
	if (runtimeMode?.workgroup) {
		const colleagueSlugs = new Set(runtimeMode.workgroup.colleagueSlugs)
		const colleagues = allModes.filter((mode) => colleagueSlugs.has(mode.slug))
		const leadName = runtimeMode.workgroup.leadModeSlug ?? runtimeMode.name
		const instructions = runtimeMode.workgroup.instructions?.trim()

		return `====

WORKGROUP COLLEAGUES

You are working as ${leadName} in the "${runtimeMode.name}" workgroup.
Delegate specialized work only with \`new_task\` and only to the colleagues below. Their professional tools, MCP servers and Skills are loaded only inside their delegated task; do not attempt to use or reproduce those tools yourself.
${colleagues
	.map((mode: ModeConfig) => {
		const description = mode.whenToUse?.trim() || mode.description || mode.roleDefinition.split(".")[0]
		return `  * "${mode.name}" (${mode.slug}) - ${description.replace(/\n/g, "\n    ")}`
	})
	.join("\n")}${instructions ? `\n\nWORKGROUP RULES\n\n${instructions}` : ""}`
	}

	const modesContent = `====

MODES

- These are the currently available modes:
${allModes
	.map((mode: ModeConfig) => {
		let description: string
		if (mode.whenToUse && mode.whenToUse.trim() !== "") {
			// Use whenToUse as the primary description, indenting subsequent lines for readability
			description = mode.whenToUse.replace(/\n/g, "\n    ")
		} else {
			// Fallback to the first sentence of roleDefinition if whenToUse is not available
			description = mode.roleDefinition.split(".")[0]
		}
		return `  * "${mode.name}" mode (${mode.slug}) - ${description}`
	})
	.join("\n")}`

	return modesContent
}
