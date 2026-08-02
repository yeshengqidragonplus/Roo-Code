import * as vscode from "vscode"

import { type ModeConfig, type PromptComponent, type CustomModePrompts, type TodoItem } from "@roo-code/types"

import {
	Mode,
	modes,
	defaultModeSlug,
	getModeBySlug,
	getExecutionModeConfig,
	getGroupName,
	getModeSelection,
} from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { formatLanguage } from "../../shared/language"
import { isEmpty } from "../../utils/object"

import { McpHub } from "../../services/mcp/McpHub"
import { CodeIndexManager } from "../../services/code-index/manager"
import { SkillsManager } from "../../services/skills/SkillsManager"

import type { SystemPromptSettings } from "./types"
import {
	getRulesSection,
	getSystemInfoSection,
	getObjectiveSection,
	getSharedToolUseSection,
	getToolUseGuidelinesSection,
	getCapabilitiesSection,
	getModesSection,
	addCustomInstructions,
	markdownFormattingSection,
	getSkillsSection,
	getMemoryInstructionsSection,
} from "./sections"

// Helper function to get prompt component, filtering out empty objects
export function getPromptComponent(
	customModePrompts: CustomModePrompts | undefined,
	mode: string,
): PromptComponent | undefined {
	const component = customModePrompts?.[mode]
	// Return undefined if component is empty
	if (isEmpty(component)) {
		return undefined
	}
	return component
}

async function generatePrompt(
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mode: Mode,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	promptComponent?: PromptComponent,
	customModeConfigs?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Record<string, boolean>,
	language?: string,
	rooIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManager,
): Promise<string> {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Get the full mode config to ensure we have the role definition (used for groups, etc.)
	const runtimeModeConfig = getModeBySlug(mode, customModeConfigs) || modes.find((m) => m.slug === mode) || modes[0]
	const modeConfig = getExecutionModeConfig(mode, customModeConfigs) || runtimeModeConfig
	const executionMode = modeConfig.slug
	const { roleDefinition, baseInstructions } = getModeSelection(executionMode, promptComponent, customModeConfigs)

	// Check if MCP functionality should be included
	const hasMcpGroup = modeConfig.groups.some((groupEntry) => getGroupName(groupEntry) === "mcp")
	const hasMcpServers = mcpHub && mcpHub.getServers().length > 0
	const shouldIncludeMcp = hasMcpGroup && hasMcpServers

	const codeIndexManager = CodeIndexManager.getInstance(context, cwd)

	// Tool calling is native-only.
	const effectiveProtocol = "native"

	const [modesSection, skillsSection] = await Promise.all([
		getModesSection(context, mode, customModeConfigs),
		getSkillsSection(skillsManager, executionMode),
	])
	const hasNonMcpToolGroup = modeConfig.groups.some((groupEntry) => getGroupName(groupEntry) !== "mcp")
	const shouldIncludeToolUse =
		hasNonMcpToolGroup || shouldIncludeMcp || Boolean(skillsSection) || Boolean(modeConfig.delegation?.canDelegate)
	const toolUseSection = shouldIncludeToolUse ? getSharedToolUseSection(modeConfig.toolUsePolicy) : ""

	// Tools catalog is not included in the system prompt.
	const toolsCatalog = ""

	// Expert system: a workflow-driven (type A) expert is steered turn-by-turn by
	// its workflow, so we suppress the self-judged completion criteria. An
	// autonomous (type B) expert relies on its terminationHint to know when the
	// long-horizon task is done. See docs/expert-system-design.md.
	const terminationSection =
		modeConfig.kind !== "workflow" && modeConfig.terminationHint
			? `\n====\n\nTASK COMPLETION CRITERIA\n\nThis task is considered complete when:\n${modeConfig.terminationHint}\n\nKeep working autonomously until these criteria are met; only then use attempt_completion.\n`
			: ""

	const basePrompt = `${roleDefinition}

${markdownFormattingSection()}

${toolUseSection}${toolsCatalog}

${getToolUseGuidelinesSection()}

${getCapabilitiesSection(cwd, shouldIncludeMcp ? mcpHub : undefined)}

${modesSection}
${skillsSection ? `\n${skillsSection}` : ""}
${getRulesSection(cwd, settings)}

${getSystemInfoSection(cwd)}

${getObjectiveSection()}
${terminationSection}
${getMemoryInstructionsSection(settings, modeConfig.useProjectMemory)}

${await addCustomInstructions(baseInstructions, globalCustomInstructions || "", cwd, executionMode, {
	language: language ?? formatLanguage(vscode.env.language),
	rooIgnoreInstructions,
	settings,
	modeUseAgentRules: modeConfig.useAgentRules,
	modeUseProjectRules: modeConfig.useProjectRules,
	modeUseProjectMemory: modeConfig.useProjectMemory,
})}`

	return basePrompt
}

export const SYSTEM_PROMPT = async (
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	mode: Mode = defaultModeSlug,
	customModePrompts?: CustomModePrompts,
	customModes?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Record<string, boolean>,
	language?: string,
	rooIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManager,
): Promise<string> => {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Get full mode config from custom modes or fall back to built-in modes
	const currentMode = getModeBySlug(mode, customModes) || modes.find((m) => m.slug === mode) || modes[0]
	// A workgroup executes as its lead. Prompt overrides must follow that lead
	// as well; otherwise a legacy workgroup role definition could overwrite the
	// lead's identity.
	const executionMode = getExecutionModeConfig(currentMode.slug, customModes)?.slug ?? currentMode.slug
	const promptComponent = getPromptComponent(customModePrompts, executionMode)

	return generatePrompt(
		context,
		cwd,
		supportsComputerUse,
		currentMode.slug,
		mcpHub,
		diffStrategy,
		promptComponent,
		customModes,
		globalCustomInstructions,
		experiments,
		language,
		rooIgnoreInstructions,
		settings,
		todoList,
		modelId,
		skillsManager,
	)
}
