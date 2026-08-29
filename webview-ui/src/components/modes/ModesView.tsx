import React, { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
	VSCodeCheckbox,
	VSCodeRadioGroup,
	VSCodeRadio,
	VSCodeTextArea,
	VSCodeLink,
	VSCodeTextField,
} from "@vscode/webview-ui-toolkit/react"
import { Trans } from "react-i18next"
import { ChevronDown, X, Upload, Download } from "lucide-react"

import { ModeConfig, GroupEntry, PromptComponent, ToolGroup, modeConfigSchema } from "@roo-code/types"

import {
	Mode,
	getRoleDefinition,
	getWhenToUse,
	getDescription,
	getCustomInstructions,
	getAllModes,
	findModeBySlug as findCustomModeBySlug,
	defaultModeSlug,
} from "@roo/modes"
import { TOOL_GROUPS } from "@roo/tools"

import { vscode } from "@src/utils/vscode"
import { buildDocLink } from "@src/utils/docLinks"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { Section } from "@src/components/settings/Section"
import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Command,
	CommandInput,
	CommandList,
	CommandEmpty,
	CommandItem,
	CommandGroup,
	Input,
	StandardTooltip,
} from "@src/components/ui"
import { DeleteModeDialog } from "@src/components/modes/DeleteModeDialog"
import { useEscapeKey } from "@src/hooks/useEscapeKey"

// Get all available groups that should show in prompts view
const availableGroups = (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((group) => !TOOL_GROUPS[group].alwaysAvailable)

type ModeSource = "global" | "project"

// --- Workgroup support -----------------------------------------------------------
// These fields are all optional; when a mode is created as "normal", the form
// behaves exactly as before (isolation principle). The helpers below build the
// <!-- SQUAD_MEMBERS_BEGIN -->...<!-- SQUAD_MEMBERS_END --> block injected into
// a squad-lead's role definition so it can discover its dispatchable members.

type CreateModeCategory = "normal" | "workflow" | "squad"
type SquadSubType = "lead" | "member"

function generateSquadMembersSection(selectedMembers: ModeConfig[], maxRetries: number): string {
	const memberLines = selectedMembers
		.map((m) => `- ${m.slug} (${m.name})：${m.whenToUse ?? m.description ?? ""}`)
		.join("\n")
	return `<!-- SQUAD_MEMBERS_BEGIN -->
可调度的专家：
${memberLines}

派单规则：
- 用 new_task 工具指定 mode 参数，message 描述任务目标+必要上下文+期望返回格式。
- 子任务返回摘要后你决定下一步：整合、重新派单、或向用户报告。
- 最多重试 ${maxRetries} 次，超过后停止派单并告知用户需要介入。
<!-- SQUAD_MEMBERS_END -->`
}

function updateRoleDefinitionWithSquad(
	roleDefinition: string,
	selectedMembers: ModeConfig[],
	maxRetries: number,
): string {
	const section = generateSquadMembersSection(selectedMembers, maxRetries)
	const beginMarker = "<!-- SQUAD_MEMBERS_BEGIN -->"
	const endMarker = "<!-- SQUAD_MEMBERS_END -->"
	if (roleDefinition.includes(beginMarker)) {
		const regex = new RegExp(`${beginMarker}[\\s\\S]*?${endMarker}`, "g")
		return roleDefinition.replace(regex, section)
	} else {
		return roleDefinition.trimEnd() + "\n\n" + section
	}
}
// --- end squad support ---------------------------------------------------------

type ImportModeResult = { type: "importModeResult"; success: boolean; slug?: string; error?: string }

// Helper to get group name regardless of format
function getGroupName(group: GroupEntry): ToolGroup {
	return Array.isArray(group) ? group[0] : group
}

const ModesView = () => {
	const { t } = useAppTranslation()

	const {
		customModePrompts,
		listApiConfigMeta,
		mode,
		customInstructions,
		setCustomInstructions,
		customModes,
		mcpServers,
		workflows,
	} = useExtensionState()

	// Request the available workflows once so the expert workflow dropdown can populate.
	useEffect(() => {
		vscode.postMessage({ type: "requestWorkflows" })
	}, [])

	// Use a local state to track the visually active mode
	// This prevents flickering when switching modes rapidly by:
	// 1. Updating the UI immediately when a mode is clicked
	// 2. Not syncing with the backend mode state (which would cause flickering)
	// 3. Still sending the mode change to the backend for persistence
	const [visualMode, setVisualMode] = useState(mode)

	// The Mode settings page edits ordinary personas only. Workflows and
	// workgroups have their own settings pages and must not leak into this list.
	const modes = useMemo(
		() => getAllModes(customModes).filter((mode) => mode.kind !== "workflow" && mode.workgroup === undefined),
		[customModes],
	)

	const [isDialogOpen, setIsDialogOpen] = useState(false)
	const [selectedPromptContent, setSelectedPromptContent] = useState("")
	const [selectedPromptTitle, setSelectedPromptTitle] = useState("")
	const [isToolsEditMode, setIsToolsEditMode] = useState(false)
	const [isMcpAssignmentOpen, setIsMcpAssignmentOpen] = useState(false)
	const [showConfigMenu, setShowConfigMenu] = useState(false)
	const [isCreateModeDialogOpen, setIsCreateModeDialogOpen] = useState(false)
	const [isExporting, setIsExporting] = useState(false)
	const [isImporting, setIsImporting] = useState(false)
	const [showImportDialog, setShowImportDialog] = useState(false)
	const [importLevel, setImportLevel] = useState<"global" | "project">("project")
	const [hasRulesToExport, setHasRulesToExport] = useState<Record<string, boolean>>({})
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
	const [modeToDelete, setModeToDelete] = useState<{
		slug: string
		name: string
		source?: string
		rulesFolderPath?: string
	} | null>(null)

	// State for mode selection popover and search
	const [open, setOpen] = useState(false)
	const [searchValue, setSearchValue] = useState("")
	const searchInputRef = useRef<HTMLInputElement>(null)

	// removed unused local name state (replaced by inline rename UX)

	// Inline rename state for the mode dropdown row
	const [isRenamingMode, setIsRenamingMode] = useState(false)
	const [renameInputValue, setRenameInputValue] = useState("")
	const renameInputRef = useRef<any>(null)

	// Optimistic rename map so search reflects new names immediately
	const [localRenames, setLocalRenames] = useState<Record<string, string>>({})
	// Settings must be able to manage hidden specialist/lead modes too. Hiding
	// only affects the chat mode picker, never the configuration editor.
	const displayModes = (modes || []).map((m) => (localRenames[m.slug] ? { ...m, name: localRenames[m.slug] } : m))

	// Direct update functions
	const updateAgentPrompt = useCallback(
		(mode: Mode, promptData: PromptComponent) => {
			const existingPrompt = customModePrompts?.[mode] as PromptComponent
			const updatedPrompt = { ...existingPrompt, ...promptData }

			// Only include properties that differ from defaults
			if (updatedPrompt.roleDefinition === getRoleDefinition(mode)) {
				delete updatedPrompt.roleDefinition
			}
			if (updatedPrompt.description === getDescription(mode)) {
				delete updatedPrompt.description
			}
			if (updatedPrompt.whenToUse === getWhenToUse(mode)) {
				delete updatedPrompt.whenToUse
			}

			vscode.postMessage({
				type: "updatePrompt",
				promptMode: mode,
				customPrompt: updatedPrompt,
			})
		},
		[customModePrompts],
	)

	const updateCustomMode = useCallback((slug: string, modeConfig: ModeConfig) => {
		const source = modeConfig.source || "global"

		vscode.postMessage({
			type: "updateCustomMode",
			slug,
			modeConfig: {
				...modeConfig,
				source, // Ensure source is set
			},
		})
	}, [])

	// Helper function to find a mode by slug
	const findModeBySlug = useCallback(
		(searchSlug: string, modes: readonly ModeConfig[] | undefined): ModeConfig | undefined => {
			return findCustomModeBySlug(searchSlug, modes)
		},
		[],
	)

	const switchMode = useCallback((slug: string) => {
		vscode.postMessage({
			type: "mode",
			text: slug,
		})
	}, [])

	// Handle mode switching with explicit state initialization
	const handleModeSwitch = useCallback(
		(modeConfig: ModeConfig) => {
			if (modeConfig.slug === visualMode) return // Prevent unnecessary updates

			// Immediately update visual state for instant feedback
			setVisualMode(modeConfig.slug)

			// Then send the mode change message to the backend
			switchMode(modeConfig.slug)

			// Exit tools edit mode when switching modes
			setIsToolsEditMode(false)
		},
		[visualMode, switchMode],
	)

	// Refs to track latest state/functions for message handler (which has no dependencies)
	const handleModeSwitchRef = useRef(handleModeSwitch)
	const customModesRef = useRef(customModes)
	const switchModeRef = useRef(switchMode)

	// Update refs when dependencies change
	useEffect(() => {
		handleModeSwitchRef.current = handleModeSwitch
	}, [handleModeSwitch])

	useEffect(() => {
		customModesRef.current = customModes
	}, [customModes])

	useEffect(() => {
		switchModeRef.current = switchMode
	}, [switchMode])

	// Sync visualMode with backend mode changes to prevent desync
	useEffect(() => {
		const activeMode = customModes?.find((customMode) => customMode.slug === mode)
		const isNonMode = activeMode?.kind === "workflow" || activeMode?.workgroup !== undefined
		setVisualMode(
			isNonMode ? (modes.find((item) => item.slug === defaultModeSlug)?.slug ?? modes[0]?.slug ?? mode) : mode,
		)
	}, [mode, customModes, modes])

	// Handler for popover open state change
	const onOpenChange = useCallback((open: boolean) => {
		setOpen(open)
		// Reset search when closing the popover
		if (!open) {
			setTimeout(() => setSearchValue(""), 100)
		}
	}, [])

	// Use the shared ESC key handler hook
	useEscapeKey(open, () => setOpen(false))

	// Handler for clearing search input
	const onClearSearch = useCallback(() => {
		setSearchValue("")
		searchInputRef.current?.focus()
	}, [])

	// Focus rename input when entering rename mode
	useEffect(() => {
		if (isRenamingMode) {
			const id = setTimeout(() => renameInputRef.current?.focus(), 0)
			return () => clearTimeout(id)
		}
	}, [isRenamingMode])

	const handleStartRenameMode = useCallback(() => {
		const customMode = findModeBySlug(visualMode, customModes)
		if (customMode) {
			setIsRenamingMode(true)
			setRenameInputValue(customMode.name)
		}
	}, [visualMode, customModes, findModeBySlug])

	const handleCancelRenameMode = useCallback(() => {
		setIsRenamingMode(false)
		setRenameInputValue("")
	}, [])

	const handleSaveRenameMode = useCallback(() => {
		const customMode = findModeBySlug(visualMode, customModes)
		const trimmed = renameInputValue.trim()
		if (!customMode || !trimmed) {
			setIsRenamingMode(false)
			return
		}
		// Prevent duplicate names against other modes
		const nameTaken = modes.some(
			(m) => m.name.toLowerCase() === trimmed.toLowerCase() && m.slug !== customMode.slug,
		)
		if (nameTaken) {
			// simple guard: do nothing if taken
			return
		}
		updateCustomMode(visualMode, {
			...customMode,
			name: trimmed,
			source: customMode.source || "global",
		})
		// Optimistically reflect rename in UI/search immediately
		setLocalRenames((prev) => ({ ...prev, [visualMode]: trimmed }))
		setIsRenamingMode(false)
	}, [visualMode, customModes, renameInputValue, modes, updateCustomMode, findModeBySlug])

	// Helper function to get current mode's config
	const getCurrentMode = useCallback((): ModeConfig | undefined => {
		const findMode = (m: ModeConfig): boolean => m.slug === visualMode
		return customModes?.find(findMode) || modes.find(findMode)
	}, [visualMode, customModes, modes])

	// Check if the current mode has rules to export
	const checkRulesDirectory = useCallback((slug: string) => {
		vscode.postMessage({
			type: "checkRulesDirectory",
			slug: slug,
		})
	}, [])

	// Check rules directory when mode changes
	useEffect(() => {
		const currentMode = getCurrentMode()
		if (currentMode?.slug && hasRulesToExport[currentMode.slug] === undefined) {
			checkRulesDirectory(currentMode.slug)
		}
	}, [getCurrentMode, checkRulesDirectory, hasRulesToExport])

	// State for create mode dialog
	const [newModeName, setNewModeName] = useState("")
	const [newModeSlug, setNewModeSlug] = useState("")
	const [newModeDescription, setNewModeDescription] = useState("")
	const [newModeRoleDefinition, setNewModeRoleDefinition] = useState("")
	const [newModeWhenToUse, setNewModeWhenToUse] = useState("")
	const [newModeCustomInstructions, setNewModeCustomInstructions] = useState("")
	const [newModeGroups, setNewModeGroups] = useState<GroupEntry[]>(availableGroups)
	const [newModeSource, setNewModeSource] = useState<ModeSource>("global")
	// Empty string = autonomous (type B); a workflow id = workflow-driven (type A).
	const [newModeWorkflowId, setNewModeWorkflowId] = useState("")

	// --- Workgroup mode form state (all optional; "normal" category leaves
	// the form identical to the pre-workgroup behavior). ---------------------
	const [createModeCategory, setCreateModeCategory] = useState<CreateModeCategory>("normal")
	const [squadSubType, setSquadSubType] = useState<SquadSubType>("lead")
	const [newModeApiProfile, setNewModeApiProfile] = useState<string>("")
	const [newModeHidden, setNewModeHidden] = useState<boolean>(false)
	const [newModeMaxDepth, setNewModeMaxDepth] = useState<number>(3)
	const [newModeUseAgentRules, setNewModeUseAgentRules] = useState<boolean>(true)
	const [newModeUseProjectRules, setNewModeUseProjectRules] = useState<boolean>(true)
	const [newModeUseProjectMemory, setNewModeUseProjectMemory] = useState<boolean>(true)
	const [newModeMaxRetries, setNewModeMaxRetries] = useState<number>(3)
	const [selectedSquadMembers, setSelectedSquadMembers] = useState<string[]>([])
	// ------------------------------------------------------------------------

	// Field-specific error states
	const [nameError, setNameError] = useState<string>("")
	const [slugError, setSlugError] = useState<string>("")
	const [descriptionError, setDescriptionError] = useState<string>("")
	const [roleDefinitionError, setRoleDefinitionError] = useState<string>("")
	const [groupsError, setGroupsError] = useState<string>("")

	// Helper to reset form state
	const resetFormState = useCallback(() => {
		// Reset form fields
		setNewModeName("")
		setNewModeSlug("")
		setNewModeDescription("")
		setNewModeGroups(availableGroups)
		setNewModeRoleDefinition("")
		setNewModeWhenToUse("")
		setNewModeCustomInstructions("")
		setNewModeSource("global")
		setNewModeWorkflowId("")
		// Reset workgroup mode state (isolation: defaults match "normal").
		setCreateModeCategory("normal")
		setSquadSubType("lead")
		setNewModeApiProfile("")
		setNewModeHidden(false)
		setNewModeMaxDepth(3)
		setNewModeUseAgentRules(true)
		setNewModeUseProjectRules(true)
		setNewModeUseProjectMemory(true)
		setNewModeMaxRetries(3)
		setSelectedSquadMembers([])
		// Reset error states
		setNameError("")
		setSlugError("")
		setDescriptionError("")
		setRoleDefinitionError("")
		setGroupsError("")
	}, [])

	// Reset form fields when dialog opens
	useEffect(() => {
		if (isCreateModeDialogOpen) {
			resetFormState()
		}
	}, [isCreateModeDialogOpen, resetFormState])

	// Ensure import dialog defaults to "project" each open
	useEffect(() => {
		if (showImportDialog) {
			setImportLevel("project")
		}
	}, [showImportDialog])

	// Helper function to generate a unique slug from a name
	const generateSlug = useCallback((name: string, attempt = 0): string => {
		const baseSlug = name
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
		return attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`
	}, [])

	// Handler for name changes
	const handleNameChange = useCallback(
		(name: string) => {
			setNewModeName(name)
			setNewModeSlug(generateSlug(name))
		},
		[generateSlug],
	)

	const handleCreateMode = useCallback(() => {
		// Clear previous errors
		setNameError("")
		setSlugError("")
		setDescriptionError("")
		setRoleDefinitionError("")
		setGroupsError("")

		const source = newModeSource
		// Build the category-specific expert fields. "normal" appends nothing,
		// preserving the exact pre-squad behavior (isolation principle).
		const categoryFields: Partial<ModeConfig> =
			createModeCategory === "workflow"
				? newModeWorkflowId
					? { kind: "workflow" as const, workflow: { workflowId: newModeWorkflowId } }
					: newModeApiProfile
						? { apiProfile: newModeApiProfile }
						: {}
				: createModeCategory === "squad" && squadSubType === "lead"
					? {
							kind: "autonomous" as const,
							...(newModeApiProfile ? { apiProfile: newModeApiProfile } : {}),
							delegation: {
								canDelegate: true,
								concurrency: "serial",
								maxDepth: newModeMaxDepth,
								maxRetries: newModeMaxRetries,
								reportMode: "summary",
							},
							workgroup: { colleagueSlugs: selectedSquadMembers },
							...(newModeHidden ? { hidden: true } : {}),
						}
					: createModeCategory === "squad" && squadSubType === "member"
						? {
								kind: "autonomous" as const,
								...(newModeApiProfile ? { apiProfile: newModeApiProfile } : {}),
								...(newModeHidden ? { hidden: true } : {}),
							}
						: {}
		const newMode: ModeConfig = {
			slug: newModeSlug,
			name: newModeName,
			description: newModeDescription.trim() || undefined,
			roleDefinition: newModeRoleDefinition.trim(),
			whenToUse: newModeWhenToUse.trim() || undefined,
			customInstructions: newModeCustomInstructions.trim() || undefined,
			groups: newModeGroups,
			source,
			...(newModeUseAgentRules ? {} : { useAgentRules: false }),
			...(newModeUseProjectRules ? {} : { useProjectRules: false }),
			...(newModeUseProjectMemory ? {} : { useProjectMemory: false }),
			...categoryFields,
		}

		// Validate the mode against the schema
		const result = modeConfigSchema.safeParse(newMode)

		if (!result.success) {
			// Map Zod errors to specific fields
			result.error.errors.forEach((error) => {
				const field = error.path[0] as string
				const message = error.message

				switch (field) {
					case "name":
						setNameError(message)
						break
					case "slug":
						setSlugError(message)
						break
					case "description":
						setDescriptionError(message)
						break
					case "roleDefinition":
						setRoleDefinitionError(message)
						break
					case "groups":
						setGroupsError(message)
						break
				}
			})
			return
		}

		updateCustomMode(newModeSlug, newMode)
		// Immediately select the newly created mode in the UI
		setVisualMode(newModeSlug)
		switchMode(newModeSlug)
		setIsCreateModeDialogOpen(false)
		resetFormState()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		newModeName,
		newModeSlug,
		newModeDescription,
		newModeRoleDefinition,
		newModeWhenToUse, // Add whenToUse dependency
		newModeCustomInstructions,
		newModeGroups,
		newModeSource,
		newModeWorkflowId,
		// Workgroup mode dependencies.
		createModeCategory,
		squadSubType,
		newModeApiProfile,
		newModeHidden,
		newModeMaxDepth,
		newModeUseAgentRules,
		newModeUseProjectRules,
		newModeUseProjectMemory,
		newModeMaxRetries,
		selectedSquadMembers,
		updateCustomMode,
	])

	const isNameOrSlugTaken = useCallback(
		(name: string, slug: string) => {
			return modes.some((m) => m.slug === slug || m.name === name)
		},
		[modes],
	)

	const openCreateModeDialog = useCallback(() => {
		const baseNamePrefix = "New Custom Mode"
		// Find unique name and slug
		let attempt = 0
		let name = baseNamePrefix
		let slug = generateSlug(name)
		while (isNameOrSlugTaken(name, slug)) {
			attempt++
			name = `${baseNamePrefix} ${attempt + 1}`
			slug = generateSlug(name)
		}
		setNewModeName(name)
		setNewModeSlug(slug)
		setIsCreateModeDialogOpen(true)
	}, [generateSlug, isNameOrSlugTaken])

	// Handler for group checkbox changes
	const handleGroupChange = useCallback(
		(group: ToolGroup, isCustomMode: boolean, customMode: ModeConfig | undefined) =>
			(e: Event | React.FormEvent<HTMLElement>) => {
				if (!isCustomMode) return // Prevent changes to built-in modes
				const target = (e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
				const checked = target.checked
				const oldGroups = customMode?.groups || []
				let newGroups: GroupEntry[]
				if (checked) {
					newGroups = [...oldGroups, group]
				} else {
					newGroups = oldGroups.filter((g) => getGroupName(g) !== group)
				}
				if (customMode) {
					const source = customMode.source || "global"

					updateCustomMode(customMode.slug, {
						...customMode,
						groups: newGroups,
						source,
					})
				}
			},
		[updateCustomMode],
	)

	// Handle clicks outside the config menu
	useEffect(() => {
		const handleClickOutside = () => {
			if (showConfigMenu) {
				setShowConfigMenu(false)
			}
		}

		document.addEventListener("click", handleClickOutside)
		return () => document.removeEventListener("click", handleClickOutside)
	}, [showConfigMenu])

	// Use a ref to store the current modeToDelete value
	const modeToDeleteRef = useRef(modeToDelete)

	// Update the ref whenever modeToDelete changes
	useEffect(() => {
		modeToDeleteRef.current = modeToDelete
	}, [modeToDelete])

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "systemPrompt") {
				if (message.text) {
					setSelectedPromptContent(message.text)
					setSelectedPromptTitle(`System Prompt (${message.mode} mode)`)
					setIsDialogOpen(true)
				}
			} else if (message.type === "exportModeResult") {
				setIsExporting(false)

				if (!message.success) {
					// Show error message
					console.error("Failed to export mode:", message.error)
				}
			} else if (message.type === "importModeResult") {
				setIsImporting(false)
				setShowImportDialog(false)

				if (message.success) {
					const { slug } = message as ImportModeResult
					if (slug) {
						// Try switching using the freshest mode list available
						const all = getAllModes(customModesRef.current)
						const importedMode = all.find((m) => m.slug === slug)
						if (importedMode) {
							handleModeSwitchRef.current(importedMode)
						} else {
							// Fallback: slug not yet in state (race condition) - select default mode
							setVisualMode(defaultModeSlug)
							switchModeRef.current?.(defaultModeSlug)
						}
					}
				} else {
					// Only log error if it's not a cancellation
					if (message.error !== "cancelled") {
						console.error("Failed to import mode:", message.error)
					}
				}
				// Note: Auto-select after import will be handled by PR #9003
			} else if (message.type === "checkRulesDirectoryResult") {
				setHasRulesToExport((prev) => ({
					...prev,
					[message.slug]: message.hasContent,
				}))
			} else if (message.type === "deleteCustomModeCheck") {
				// Handle the check response
				// Use the ref to get the current modeToDelete value
				const currentModeToDelete = modeToDeleteRef.current
				if (message.slug && currentModeToDelete && currentModeToDelete.slug === message.slug) {
					setModeToDelete({
						...currentModeToDelete,
						rulesFolderPath: message.rulesFolderPath,
					})
					setShowDeleteConfirm(true)
				}
			}
		}

		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [checkRulesDirectory, switchMode])

	const handleAgentReset = (
		modeSlug: string,
		type: "roleDefinition" | "description" | "whenToUse" | "customInstructions",
	) => {
		// Only reset for built-in modes
		const existingPrompt = customModePrompts?.[modeSlug] as PromptComponent
		const updatedPrompt = { ...existingPrompt }
		delete updatedPrompt[type] // Remove the field entirely to ensure it reloads from defaults

		vscode.postMessage({
			type: "updatePrompt",
			promptMode: modeSlug,
			customPrompt: updatedPrompt,
		})
	}

	return (
		<div>
			<Section>
				<div>
					<div onClick={(e) => e.stopPropagation()} className="flex justify-between items-center mb-3">
						<h3 className="text-[1.25em] font-semibold text-vscode-foreground mt-4 mb-2">
							{t("prompts:modes.title")}
						</h3>
						<div className="flex gap-2">
							<div className="relative inline-block">
								<StandardTooltip content={t("prompts:modes.editModesConfig")}>
									<Button
										variant="ghost"
										size="icon"
										className="flex"
										onClick={(e: React.MouseEvent) => {
											e.preventDefault()
											e.stopPropagation()
											setShowConfigMenu((prev) => !prev)
										}}
										onBlur={() => {
											// Add slight delay to allow menu item clicks to register
											setTimeout(() => setShowConfigMenu(false), 200)
										}}>
										<span className="codicon codicon-json"></span>
									</Button>
								</StandardTooltip>
								{showConfigMenu && (
									<div
										onClick={(e) => e.stopPropagation()}
										onMouseDown={(e) => e.stopPropagation()}
										className="absolute top-full right-0 w-[200px] mt-1 bg-vscode-editor-background border border-vscode-input-border rounded shadow-md z-[1000]">
										<div
											className="p-2 cursor-pointer text-vscode-foreground text-sm"
											onMouseDown={(e) => {
												e.preventDefault() // Prevent blur
												vscode.postMessage({
													type: "openCustomModesSettings",
												})
												setShowConfigMenu(false)
											}}
											onClick={(e) => e.preventDefault()}>
											{t("prompts:modes.editGlobalModes")}
										</div>
										<div
											className="p-2 cursor-pointer text-vscode-foreground text-sm border-t border-vscode-input-border"
											onMouseDown={(e) => {
												e.preventDefault() // Prevent blur
												vscode.postMessage({
													type: "openFile",
													text: "./.roomodes",
													values: {
														create: true,
														content: JSON.stringify({ customModes: [] }, null, 2),
													},
												})
												setShowConfigMenu(false)
											}}
											onClick={(e) => e.preventDefault()}>
											{t("prompts:modes.editProjectModes")}
										</div>
									</div>
								)}
							</div>
							<StandardTooltip content={t("prompts:modes.importMode")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => setShowImportDialog(true)}
									disabled={isImporting}
									title={t("prompts:modes.importMode")}
									data-testid="import-mode-toolbar-button">
									<Download className="h-4 w-4" />
								</Button>
							</StandardTooltip>
						</div>
					</div>

					<div className="text-sm text-vscode-descriptionForeground mb-3">
						<Trans i18nKey="prompts:modes.createModeHelpText">
							<VSCodeLink
								href={buildDocLink("basic-usage/using-modes", "prompts_view_modes")}
								style={{ display: "inline" }}
								aria-label="Learn about using modes"></VSCodeLink>
							<VSCodeLink
								href={buildDocLink("features/custom-modes", "prompts_view_modes")}
								style={{ display: "inline" }}
								aria-label="Learn about customizing modes"></VSCodeLink>
						</Trans>
					</div>

					<div className="flex items-center gap-1 mb-3">
						{isRenamingMode ? (
							<>
								<VSCodeTextField
									ref={renameInputRef}
									value={renameInputValue}
									onInput={(e: unknown) => {
										const target = e as { target: { value: string } }
										setRenameInputValue(target.target.value)
									}}
									className="grow"
									placeholder={t("prompts:createModeDialog.name.placeholder")}
								/>
								<StandardTooltip content={t("settings:common.save")}>
									<Button
										variant="ghost"
										size="icon"
										disabled={!renameInputValue.trim()}
										onClick={handleSaveRenameMode}
										data-testid="save-mode-rename-button">
										<span className="codicon codicon-check" />
									</Button>
								</StandardTooltip>
								<StandardTooltip content={t("settings:common.cancel")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={handleCancelRenameMode}
										data-testid="cancel-mode-rename-button">
										<span className="codicon codicon-close" />
									</Button>
								</StandardTooltip>
							</>
						) : (
							<>
								<Popover open={open} onOpenChange={onOpenChange}>
									<PopoverTrigger asChild>
										<Button
											variant="combobox"
											role="combobox"
											aria-expanded={open}
											className="justify-between grow"
											data-testid="mode-select-trigger">
											<div className="truncate">
												{localRenames[visualMode] ??
													getCurrentMode()?.name ??
													t("prompts:modes.selectMode")}
											</div>
											<ChevronDown className="opacity-50" />
										</Button>
									</PopoverTrigger>
									<PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]">
										<Command>
											<div className="relative">
												<CommandInput
													ref={searchInputRef}
													value={searchValue}
													onValueChange={setSearchValue}
													placeholder={t("prompts:modes.selectMode")}
													className="h-9 mr-4"
													data-testid="mode-search-input"
												/>
												{searchValue.length > 0 && (
													<div className="absolute right-2 top-0 bottom-0 flex items-center justify-center">
														<X
															className="text-vscode-input-foreground opacity-50 hover:opacity-100 size-4 p-0.5 cursor-pointer"
															onClick={onClearSearch}
														/>
													</div>
												)}
											</div>
											<CommandList>
												<CommandEmpty>
													{searchValue && (
														<div className="py-2 px-1 text-sm">
															{t("prompts:modes.noMatchFound")}
														</div>
													)}
												</CommandEmpty>
												<CommandGroup>
													{displayModes
														.filter((modeConfig) =>
															searchValue
																? modeConfig.name
																		.toLowerCase()
																		.includes(searchValue.toLowerCase())
																: true,
														)
														.map((modeConfig) => (
															<CommandItem
																key={modeConfig.slug}
																value={`${modeConfig.name} ${modeConfig.slug}`}
																onSelect={() => {
																	handleModeSwitch(modeConfig)
																	setOpen(false)
																}}
																data-testid={`mode-option-${modeConfig.slug}`}>
																<div className="flex items-center justify-between w-full">
																	<span
																		style={{
																			whiteSpace: "nowrap",
																			overflow: "hidden",
																			textOverflow: "ellipsis",
																			flex: 2,
																			minWidth: 0,
																		}}>
																		{modeConfig.name}
																	</span>
																	<span
																		className="text-foreground"
																		style={{
																			whiteSpace: "nowrap",
																			overflow: "hidden",
																			textOverflow: "ellipsis",
																			direction: "rtl",
																			textAlign: "right",
																			flex: 1,
																			minWidth: 0,
																			marginLeft: "0.5em",
																		}}>
																		{modeConfig.slug}
																	</span>
																</div>
															</CommandItem>
														))}
												</CommandGroup>
											</CommandList>
										</Command>
									</PopoverContent>
								</Popover>

								{/* New mode (+) moved here from the top bar */}
								<StandardTooltip content={t("prompts:modes.createNewMode")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={openCreateModeDialog}
										data-testid="add-mode-button">
										<span className="codicon codicon-add" />
									</Button>
								</StandardTooltip>

								{/* Edit (rename) mode - only enabled for custom modes */}
								<StandardTooltip content={t("settings:providers.renameProfile")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={handleStartRenameMode}
										data-testid="rename-mode-button"
										disabled={!findModeBySlug(visualMode, customModes)}>
										<span className="codicon codicon-edit" />
									</Button>
								</StandardTooltip>

								{/* Delete mode - disabled for built-in modes */}
								<StandardTooltip content={t("prompts:createModeDialog.deleteMode")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => {
											const customMode = findModeBySlug(visualMode, customModes)
											if (customMode) {
												setModeToDelete({
													slug: customMode.slug,
													name: customMode.name,
													source: customMode.source || "global",
												})
												vscode.postMessage({
													type: "deleteCustomMode",
													slug: customMode.slug,
													checkOnly: true,
												})
											}
										}}
										data-testid="delete-mode-button"
										disabled={!findModeBySlug(visualMode, customModes)}>
										<span className="codicon codicon-trash" />
									</Button>
								</StandardTooltip>

								{/* Export mode (kept here to the right of the dropdown) */}
								<StandardTooltip content={t("prompts:exportMode.title")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => {
											const currentMode = getCurrentMode()
											if (currentMode?.slug && !isExporting) {
												setIsExporting(true)
												vscode.postMessage({
													type: "exportMode",
													slug: currentMode.slug,
												})
											}
										}}
										disabled={isExporting}
										title={t("prompts:exportMode.title")}
										data-testid="export-mode-toolbar-button">
										<Upload className="h-4 w-4" />
									</Button>
								</StandardTooltip>
							</>
						)}
					</div>

					{findModeBySlug(visualMode, customModes) && (
						<div className="mb-3">
							<div className="font-bold mb-1">默认 API 配置（执行模型）</div>
							<div className="text-sm text-vscode-descriptionForeground mb-2">
								此配置会在切换或委派到该 Mode 时使用；它不改变其他 Mode 的默认模型。
							</div>
							<Select
								value={findModeBySlug(visualMode, customModes)?.apiProfile || "__none__"}
								onValueChange={(value) => {
									const currentMode = findModeBySlug(visualMode, customModes)
									if (currentMode) {
										updateCustomMode(visualMode, {
											...currentMode,
											apiProfile: value === "__none__" ? undefined : value,
										})
									}
								}}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__none__">不绑定（使用会话当前配置）</SelectItem>
									{(listApiConfigMeta || []).map((config) => (
										<SelectItem key={config.id} value={config.name}>
											{config.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{findModeBySlug(visualMode, customModes) && (
						<div className="mb-3">
							<VSCodeCheckbox
								checked={findModeBySlug(visualMode, customModes)?.useAgentRules !== false}
								onChange={(e: Event | React.FormEvent<HTMLElement>) => {
									const target = (e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
									const currentMode = findModeBySlug(visualMode, customModes)
									if (currentMode) {
										updateCustomMode(visualMode, {
											...currentMode,
											useAgentRules: target.checked ? undefined : false,
										})
									}
								}}>
								注入 AGENTS.md（仓库贡献指南）
								<div className="text-xs text-vscode-descriptionForeground mt-0.5">
									辅助专家（如 web-researcher
									等被委派的同事模式）不修改仓库代码，建议关闭以精简系统提示词。关闭后该模式的提示词不再拼接
									AGENTS.md 内容。
								</div>
							</VSCodeCheckbox>
						</div>
					)}

					{findModeBySlug(visualMode, customModes) && (
						<div className="mb-3">
							<VSCodeCheckbox
								checked={findModeBySlug(visualMode, customModes)?.useProjectRules !== false}
								onChange={(e: Event | React.FormEvent<HTMLElement>) => {
									const target = (e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
									const currentMode = findModeBySlug(visualMode, customModes)
									if (currentMode) {
										updateCustomMode(visualMode, {
											...currentMode,
											useProjectRules: target.checked ? undefined : false,
										})
									}
								}}>
								注入项目规则（.roo/rules）
								<div className="text-xs text-vscode-descriptionForeground mt-0.5">
									关闭后该模式的提示词不再拼接 .roo/rules/ 通用规则和 .roo/rules-{mode}/
									专属规则。辅助专家建议关闭。
								</div>
							</VSCodeCheckbox>
						</div>
					)}

					{findModeBySlug(visualMode, customModes) && (
						<div className="mb-3">
							<VSCodeCheckbox
								checked={findModeBySlug(visualMode, customModes)?.useProjectMemory !== false}
								onChange={(e: Event | React.FormEvent<HTMLElement>) => {
									const target = (e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
									const currentMode = findModeBySlug(visualMode, customModes)
									if (currentMode) {
										updateCustomMode(visualMode, {
											...currentMode,
											useProjectMemory: target.checked ? undefined : false,
										})
									}
								}}>
								注入项目记忆（.roo/memory）
								<div className="text-xs text-vscode-descriptionForeground mt-0.5">
									关闭后该模式的提示词不再拼接 .roo/memory/ 项目记忆，也不再输出 PROJECT MEMORY
									写入指令。辅助专家建议关闭。
								</div>
							</VSCodeCheckbox>
						</div>
					)}
				</div>

				<div className="text-xs font-semibold uppercase tracking-wide text-vscode-descriptionForeground mb-2">
					系统提示词：发送给模型
				</div>
				{/* Role Definition section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">角色与职责（系统提示词）</div>
						{!findModeBySlug(visualMode, customModes) && (
							<StandardTooltip content={t("prompts:roleDefinition.resetToDefault")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => {
										const currentMode = getCurrentMode()
										if (currentMode?.slug) {
											handleAgentReset(currentMode.slug, "roleDefinition")
										}
									}}
									data-testid="role-definition-reset">
									<span className="codicon codicon-discard"></span>
								</Button>
							</StandardTooltip>
						)}
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:roleDefinition.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return customMode?.roleDefinition ?? prompt?.roleDefinition ?? getRoleDefinition(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									roleDefinition: value.trim() || "",
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								updateAgentPrompt(visualMode, {
									roleDefinition: value.trim() || undefined,
								})
							}
						}}
						className="w-full"
						rows={5}
						data-testid={`${getCurrentMode()?.slug || "code"}-prompt-textarea`}
					/>
				</div>

				<div className="text-xs font-semibold uppercase tracking-wide text-vscode-descriptionForeground mb-2">
					用户可见信息：用于模式选择与说明
				</div>
				{/* Description section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">简短说明（用户可见）</div>
						{!findModeBySlug(visualMode, customModes) && (
							<StandardTooltip content={t("prompts:description.resetToDefault")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => {
										const currentMode = getCurrentMode()
										if (currentMode?.slug) {
											handleAgentReset(currentMode.slug, "description")
										}
									}}
									data-testid="description-reset">
									<span className="codicon codicon-discard"></span>
								</Button>
							</StandardTooltip>
						)}
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:description.description")}
					</div>
					<VSCodeTextField
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return customMode?.description ?? prompt?.description ?? getDescription(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									description: value.trim() || undefined,
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								updateAgentPrompt(visualMode, {
									description: value.trim() || undefined,
								})
							}
						}}
						className="w-full"
						data-testid={`${getCurrentMode()?.slug || "code"}-description-textfield`}
					/>
				</div>

				{/* When to Use section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">使用场景（用户可见；供系统路由参考）</div>
						{!findModeBySlug(visualMode, customModes) && (
							<StandardTooltip content={t("prompts:whenToUse.resetToDefault")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => {
										const currentMode = getCurrentMode()
										if (currentMode?.slug) {
											handleAgentReset(currentMode.slug, "whenToUse")
										}
									}}
									data-testid="when-to-use-reset">
									<span className="codicon codicon-discard"></span>
								</Button>
							</StandardTooltip>
						)}
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:whenToUse.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return customMode?.whenToUse ?? prompt?.whenToUse ?? getWhenToUse(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									whenToUse: value.trim() || undefined,
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								updateAgentPrompt(visualMode, {
									whenToUse: value.trim() || undefined,
								})
							}
						}}
						className="w-full"
						rows={4}
						data-testid={`${getCurrentMode()?.slug || "code"}-when-to-use-textarea`}
					/>
				</div>

				<div className="text-xs font-semibold uppercase tracking-wide text-vscode-descriptionForeground mb-2">
					系统执行配置：工具与补充提示词
				</div>
				{/* Mode settings */}
				<>
					{/* Show tools for all modes */}
					<div className="mb-4">
						<div className="flex justify-between items-center mb-1">
							<div className="font-bold">{t("prompts:tools.title")}</div>
							{findModeBySlug(visualMode, customModes) && (
								<StandardTooltip
									content={
										isToolsEditMode ? t("prompts:tools.doneEditing") : t("prompts:tools.editTools")
									}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => setIsToolsEditMode(!isToolsEditMode)}>
										<span
											className={`codicon codicon-${isToolsEditMode ? "check" : "edit"}`}></span>
									</Button>
								</StandardTooltip>
							)}
						</div>
						{!findModeBySlug(visualMode, customModes) && (
							<div className="text-sm text-vscode-descriptionForeground mb-2">
								{t("prompts:tools.builtInModesText")}
							</div>
						)}
						{isToolsEditMode && findModeBySlug(visualMode, customModes) ? (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
								{availableGroups.map((group) => {
									const currentMode = getCurrentMode()
									const isCustomMode = findModeBySlug(visualMode, customModes)
									const customMode = isCustomMode
									const isGroupEnabled = isCustomMode
										? customMode?.groups?.some((g) => getGroupName(g) === group)
										: currentMode?.groups?.some((g) => getGroupName(g) === group)

									return (
										<VSCodeCheckbox
											key={group}
											checked={isGroupEnabled}
											onChange={handleGroupChange(group, Boolean(isCustomMode), customMode)}
											disabled={!isCustomMode}>
											{t(`prompts:tools.toolNames.${group}`)}
											{group === "edit" && (
												<div className="text-xs text-vscode-descriptionForeground mt-0.5">
													{t("prompts:tools.allowedFiles")}{" "}
													{(() => {
														const currentMode = getCurrentMode()
														const editGroup = currentMode?.groups?.find(
															(g) =>
																Array.isArray(g) && g[0] === "edit" && g[1]?.fileRegex,
														)
														if (!Array.isArray(editGroup)) return t("prompts:allFiles")
														return editGroup[1].description || `/${editGroup[1].fileRegex}/`
													})()}
												</div>
											)}
										</VSCodeCheckbox>
									)
								})}
							</div>
						) : (
							<div className="text-sm text-vscode-foreground mb-2 leading-relaxed">
								{(() => {
									const currentMode = getCurrentMode()
									const enabledGroups = currentMode?.groups || []

									// If there are no enabled groups, display translated "None"
									if (enabledGroups.length === 0) {
										return t("prompts:tools.noTools")
									}

									return enabledGroups
										.map((group) => {
											const groupName = getGroupName(group)
											const displayName = t(`prompts:tools.toolNames.${groupName}`)
											if (Array.isArray(group) && group[1]?.fileRegex) {
												const description = group[1].description || `/${group[1].fileRegex}/`
												return `${displayName} (${description})`
											}
											return displayName
										})
										.join(", ")
								})()}
							</div>
						)}
					</div>
				</>

				{/* MCP assignment: servers remain globally visible in MCP Settings,
				    while this list controls which server tools enter this Mode's prompt. */}
				{findModeBySlug(visualMode, customModes) && (
					<div className="mb-4">
						<div className="font-bold mb-1">已分配 MCP</div>
						<div className="text-sm text-vscode-descriptionForeground mb-2">
							MCP 服务始终在“MCP 服务”页完整显示；这里只决定哪些服务的工具会注入当前 Mode 的系统提示词。
						</div>
						{(() => {
							const currentMode = getCurrentMode()
							const canUseMcp = currentMode?.groups?.some((group) => getGroupName(group) === "mcp")
							const availableModeSlugs = modes.map((item) => item.slug)
							const assignedCount = mcpServers.filter((server) => {
								try {
									const configuredModes = (JSON.parse(server.config) as { modes?: unknown }).modes
									return !Array.isArray(configuredModes) || configuredModes.includes(visualMode)
								} catch {
									return false
								}
							}).length

							return (
								<>
									{!canUseMcp && (
										<div className="text-sm text-vscode-descriptionForeground mb-2">
											请先在“工具权限”中开启 MCP，才能为此 Mode 分配服务。
										</div>
									)}
									<Popover open={isMcpAssignmentOpen} onOpenChange={setIsMcpAssignmentOpen}>
										<PopoverTrigger asChild>
											<Button
												variant="secondary"
												disabled={!canUseMcp || mcpServers.length === 0}>
												选择 MCP（{assignedCount}/{mcpServers.length}）
											</Button>
										</PopoverTrigger>
										<PopoverContent className="w-80 max-h-80 overflow-y-auto">
											<div className="flex flex-col gap-2">
												{mcpServers.map((server) => {
													let explicitModeSlugs: string[] | undefined
													try {
														const parsedConfig = JSON.parse(server.config) as {
															modes?: unknown
														}
														if (Array.isArray(parsedConfig.modes)) {
															explicitModeSlugs = parsedConfig.modes.filter(
																(value): value is string => typeof value === "string",
															)
														}
													} catch {
														// Keep the server visible. An invalid config is handled by the MCP settings page.
													}

													const assigned = explicitModeSlugs
														? explicitModeSlugs.includes(visualMode)
														: true
													return (
														<VSCodeCheckbox
															key={`${server.name}-${server.source || "global"}`}
															checked={assigned}
															disabled={!canUseMcp}
															onChange={(event) => {
																const checked = (event.target as HTMLInputElement)
																	.checked
																const nextModeSlugs = checked
																	? [
																			...new Set([
																				...(explicitModeSlugs ??
																					availableModeSlugs),
																				visualMode,
																			]),
																		]
																	: (explicitModeSlugs ?? availableModeSlugs).filter(
																			(slug) => slug !== visualMode,
																		)
																vscode.postMessage({
																	type: "updateMcpServerModes",
																	serverName: server.name,
																	source: server.source || "global",
																	modeSlugs: nextModeSlugs,
																})
															}}>
															{server.name}
															{server.disabled ? "（已停用）" : ""}
														</VSCodeCheckbox>
													)
												})}
											</div>
										</PopoverContent>
									</Popover>
								</>
							)
						})()}
					</div>
				)}

				{/* Role definition for both built-in and custom modes */}
				<div className="mb-2">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:customInstructions.title")}</div>
						{!findModeBySlug(visualMode, customModes) && (
							<StandardTooltip content={t("prompts:customInstructions.resetToDefault")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => {
										const currentMode = getCurrentMode()
										if (currentMode?.slug) {
											handleAgentReset(currentMode.slug, "customInstructions")
										}
									}}
									data-testid="custom-instructions-reset">
									<span className="codicon codicon-discard"></span>
								</Button>
							</StandardTooltip>
						)}
					</div>
					<div className="text-[13px] text-vscode-descriptionForeground mb-2">
						{t("prompts:customInstructions.description", {
							modeName: getCurrentMode()?.name || "Code",
						})}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return (
								customMode?.customInstructions ??
								prompt?.customInstructions ??
								getCustomInstructions(visualMode, customModes)
							)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									// Preserve empty string; only treat null/undefined as unset
									customInstructions: value ?? undefined,
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								const existingPrompt = customModePrompts?.[visualMode] as PromptComponent
								updateAgentPrompt(visualMode, {
									...existingPrompt,
									customInstructions: value.trim() || undefined,
								})
							}
						}}
						rows={10}
						className="w-full"
						data-testid={`${getCurrentMode()?.slug || "code"}-custom-instructions-textarea`}
					/>
					<div className="text-xs text-vscode-descriptionForeground mt-1.5">
						<Trans
							i18nKey="prompts:customInstructions.loadFromFile"
							values={{
								mode: getCurrentMode()?.name || "Code",
								slug: getCurrentMode()?.slug || "code",
							}}
							components={{
								span: (
									<span
										className="text-vscode-textLink-foreground cursor-pointer underline"
										onClick={() => {
											const currentMode = getCurrentMode()
											if (!currentMode) return

											// Open or create an empty file
											vscode.postMessage({
												type: "openFile",
												text: `./.roo/rules-${currentMode.slug}/rules.md`,
												values: {
													create: true,
													content: "",
												},
											})
										}}
									/>
								),
								"0": (
									<VSCodeLink
										href={buildDocLink(
											"features/custom-instructions#global-rules-directory",
											"prompts_mode_specific_global_rules",
										)}
										style={{ display: "inline" }}
										aria-label="Learn about global custom instructions for modes"
									/>
								),
							}}
						/>
					</div>
				</div>

				<div className="pb-4 border-b border-vscode-input-border">
					<div className="flex gap-2 mb-4">
						<Button
							variant="primary"
							onClick={() => {
								const currentMode = getCurrentMode()
								if (currentMode) {
									vscode.postMessage({
										type: "getSystemPrompt",
										mode: currentMode.slug,
									})
								}
							}}
							data-testid="preview-prompt-button">
							{t("prompts:systemPrompt.preview")}
						</Button>
						<StandardTooltip content={t("prompts:systemPrompt.copy")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									const currentMode = getCurrentMode()
									if (currentMode) {
										vscode.postMessage({
											type: "copySystemPrompt",
											mode: currentMode.slug,
										})
									}
								}}
								data-testid="copy-prompt-button">
								<span className="codicon codicon-copy"></span>
							</Button>
						</StandardTooltip>
					</div>
				</div>

				<div className="pb-5">
					<h3 className="text-vscode-foreground mb-3">{t("prompts:globalCustomInstructions.title")}</h3>

					<div className="text-sm text-vscode-descriptionForeground mb-2">
						<Trans i18nKey="prompts:globalCustomInstructions.description">
							<VSCodeLink
								href={buildDocLink(
									"features/custom-instructions#setting-up-global-rules",
									"prompts_global_custom_instructions",
								)}
								style={{ display: "inline" }}
								aria-label="Learn more about global custom instructions"></VSCodeLink>
						</Trans>
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={customInstructions || ""}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							setCustomInstructions(value ?? undefined)
							vscode.postMessage({
								type: "customInstructions",
								text: value ?? undefined,
							})
						}}
						rows={4}
						className="w-full"
						data-testid="global-custom-instructions-textarea"
					/>
					<div className="text-xs text-vscode-descriptionForeground mt-1.5">
						<Trans
							i18nKey="prompts:globalCustomInstructions.loadFromFile"
							components={{
								span: (
									<span
										className="text-vscode-textLink-foreground cursor-pointer underline"
										onClick={() =>
											vscode.postMessage({
												type: "openFile",
												text: "./.roo/rules/rules.md",
												values: {
													create: true,
													content: "",
												},
											})
										}
									/>
								),
								"0": (
									<VSCodeLink
										href={buildDocLink(
											"features/custom-instructions#setting-up-global-rules",
											"prompts_global_rules",
										)}
										style={{ display: "inline" }}
										aria-label="Learn about setting up global custom instructions"
									/>
								),
							}}
						/>
					</div>
				</div>
			</Section>

			{isCreateModeDialogOpen && (
				<div className="fixed inset-0 flex justify-end bg-black/50 z-[1000]">
					<div className="w-[calc(100vw-100px)] h-full bg-vscode-editor-background shadow-md flex flex-col relative">
						<div className="flex-1 p-5 overflow-y-auto min-h-0">
							<Button
								variant="ghost"
								size="icon"
								onClick={() => setIsCreateModeDialogOpen(false)}
								className="absolute top-5 right-5">
								<span className="codicon codicon-close"></span>
							</Button>
							<h2 className="mb-4">{t("prompts:createModeDialog.title")}</h2>
							{/* Mode category selector: single mode / workflow / workgroup. */}
							<div className="mb-4 rounded border border-vscode-editor-lineHighlightBorder p-3 text-sm text-vscode-descriptionForeground">
								此页面仅创建普通 Mode。工作流请在“工作流”中管理，工作群组请在“工作群组”中管理。
							</div>
							<div className="hidden">
								<div className="font-bold mb-1">类型</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									选择创建的模式类型。
								</div>
								<VSCodeRadioGroup
									value={createModeCategory}
									onChange={(e: Event | React.FormEvent<HTMLElement>) => {
										const target = ((e as CustomEvent)?.detail?.target ||
											(e.target as HTMLInputElement)) as HTMLInputElement
										const next = target.value as CreateModeCategory
										setCreateModeCategory(next)
										// Default handling per spec:
										// - switching to squad defaults subType=lead, hidden=false
										// - switching to squad-member defaults hidden=true
										if (next === "squad") {
											setSquadSubType("lead")
											setNewModeHidden(false)
										} else {
											// leaving squad: reset hidden to its neutral default
											setNewModeHidden(false)
										}
									}}>
									<VSCodeRadio value="normal">
										单个 Mode
										<div className="text-xs text-vscode-descriptionForeground mt-0.5">
											日常独立工作模式；保持现有 Mode 的使用方式
										</div>
									</VSCodeRadio>
									<VSCodeRadio value="workflow">
										流程
										<div className="text-xs text-vscode-descriptionForeground mt-0.5">
											绑定工作流图，按预定义流程执行
										</div>
									</VSCodeRadio>
									<VSCodeRadio value="squad">
										工作群组
										<div className="text-xs text-vscode-descriptionForeground mt-0.5">
											由协调者和一组专业同事协作完成任务；当前按串行委派执行
										</div>
									</VSCodeRadio>
								</VSCodeRadioGroup>
								{createModeCategory === "squad" && (
									<div className="mt-3">
										<div className="font-bold mb-1">工作群组角色</div>
										<VSCodeRadioGroup
											value={squadSubType}
											onChange={(e: Event | React.FormEvent<HTMLElement>) => {
												const target = ((e as CustomEvent)?.detail?.target ||
													(e.target as HTMLInputElement)) as HTMLInputElement
												const next = target.value as SquadSubType
												setSquadSubType(next)
												// member defaults hidden=true; lead defaults hidden=false
												setNewModeHidden(next === "member")
											}}>
											<VSCodeRadio value="lead">
												协调者
												<div className="text-xs text-vscode-descriptionForeground mt-0.5">
													分解任务、委派同事并整合结果
												</div>
											</VSCodeRadio>
											<VSCodeRadio value="member">
												同事
												<div className="text-xs text-vscode-descriptionForeground mt-0.5">
													专业工作者，由协调者委派明确工作单
												</div>
											</VSCodeRadio>
										</VSCodeRadioGroup>
									</div>
								)}
							</div>
							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.name.label")}</div>
								<Input
									type="text"
									value={newModeName}
									onChange={(e) => {
										handleNameChange(e.target.value)
									}}
									className="w-full"
								/>
								{nameError && (
									<div className="text-xs text-vscode-errorForeground mt-1">{nameError}</div>
								)}
							</div>
							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.slug.label")}</div>
								<Input
									type="text"
									value={newModeSlug}
									onChange={(e) => {
										setNewModeSlug(e.target.value)
									}}
									className="w-full"
								/>
								<div className="text-xs text-vscode-descriptionForeground mt-1">
									{t("prompts:createModeDialog.slug.description")}
								</div>
								{slugError && (
									<div className="text-xs text-vscode-errorForeground mt-1">{slugError}</div>
								)}
							</div>
							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.saveLocation.label")}</div>
								<div className="text-sm text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.saveLocation.description")}
								</div>
								<VSCodeRadioGroup
									value={newModeSource}
									onChange={(e: Event | React.FormEvent<HTMLElement>) => {
										const target = ((e as CustomEvent)?.detail?.target ||
											(e.target as HTMLInputElement)) as HTMLInputElement
										setNewModeSource(target.value as ModeSource)
									}}>
									<VSCodeRadio value="global">
										{t("prompts:createModeDialog.saveLocation.global.label")}
										<div className="text-xs text-vscode-descriptionForeground mt-0.5">
											{t("prompts:createModeDialog.saveLocation.global.description")}
										</div>
									</VSCodeRadio>
									<VSCodeRadio value="project">
										{t("prompts:createModeDialog.saveLocation.project.label")}
										<div className="text-xs text-vscode-descriptionForeground mt-0.5">
											{t("prompts:createModeDialog.saveLocation.project.description")}
										</div>
									</VSCodeRadio>
								</VSCodeRadioGroup>
							</div>

							<div style={{ marginBottom: "16px" }}>
								<div style={{ fontWeight: "bold", marginBottom: "4px" }}>
									{t("prompts:createModeDialog.roleDefinition.label")}
								</div>
								<div
									style={{
										fontSize: "13px",
										color: "var(--vscode-descriptionForeground)",
										marginBottom: "8px",
									}}>
									{t("prompts:createModeDialog.roleDefinition.description")}
								</div>
								<VSCodeTextArea
									resize="vertical"
									value={newModeRoleDefinition}
									onChange={(e) => {
										setNewModeRoleDefinition((e.target as HTMLTextAreaElement).value)
									}}
									rows={4}
									className="w-full"
								/>
								{roleDefinitionError && (
									<div className="text-xs text-vscode-errorForeground mt-1">
										{roleDefinitionError}
									</div>
								)}
							</div>

							<div className="mb-4">
								<div className="font-bold mb-1">默认 API 配置（执行模型）</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									创建后切换或委派到此 Mode 时使用。留空表示使用会话当前配置。
								</div>
								<Select
									value={newModeApiProfile || "__none__"}
									onValueChange={(value) => setNewModeApiProfile(value === "__none__" ? "" : value)}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="__none__">不绑定</SelectItem>
										{(listApiConfigMeta || []).map((config) => (
											<SelectItem key={config.id} value={config.name}>
												{config.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div className="mb-4">
								<VSCodeCheckbox
									checked={newModeUseAgentRules}
									onChange={(e: Event | React.FormEvent<HTMLElement>) => {
										const target =
											(e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
										setNewModeUseAgentRules(target.checked)
									}}>
									注入 AGENTS.md（仓库贡献指南）
									<div className="text-xs text-vscode-descriptionForeground mt-0.5">
										辅助专家（被委派的同事模式）建议关闭：不修改仓库代码时 AGENTS.md
										内容只会污染系统提示词。
									</div>
								</VSCodeCheckbox>
							</div>

							<div className="mb-4">
								<VSCodeCheckbox
									checked={newModeUseProjectRules}
									onChange={(e: Event | React.FormEvent<HTMLElement>) => {
										const target =
											(e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
										setNewModeUseProjectRules(target.checked)
									}}>
									注入项目规则（.roo/rules）
									<div className="text-xs text-vscode-descriptionForeground mt-0.5">
										关闭后不再拼接 .roo/rules/ 通用规则和 .roo/rules-{mode}/
										专属规则。辅助专家建议关闭。
									</div>
								</VSCodeCheckbox>
							</div>

							<div className="mb-4">
								<VSCodeCheckbox
									checked={newModeUseProjectMemory}
									onChange={(e: Event | React.FormEvent<HTMLElement>) => {
										const target =
											(e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
										setNewModeUseProjectMemory(target.checked)
									}}>
									注入项目记忆（.roo/memory）
									<div className="text-xs text-vscode-descriptionForeground mt-0.5">
										关闭后不再拼接 .roo/memory/ 项目记忆，也不再输出 PROJECT MEMORY
										写入指令。辅助专家建议关闭。
									</div>
								</VSCodeCheckbox>
							</div>

							{/* Workgroup colleague hint: pure text guidance below role definition. */}
							{createModeCategory === "squad" && squadSubType === "member" && (
								<div className="mb-4 text-[13px] text-vscode-descriptionForeground">
									同事模式通常设为 hidden：它不会出现在模式选择器中，仅由协调者通过 new_task
									委派调用。请在 Role Definition 中写明该同事的专业领域与职责边界。
								</div>
							)}

							{/* Workgroup coordinator specific fields. */}
							{createModeCategory === "squad" && squadSubType === "lead" && (
								<>
									<div className="mb-4">
										<div className="font-bold mb-1">API Profile</div>
										<div className="text-[13px] text-vscode-descriptionForeground mb-2">
											绑定到该模式时激活的 API 配置（可选）。留空表示不绑定。
										</div>
										<Select
											value={newModeApiProfile || "__none__"}
											onValueChange={(v) => setNewModeApiProfile(v === "__none__" ? "" : v)}>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="__none__">不绑定</SelectItem>
												{(listApiConfigMeta || []).map((config) => (
													<SelectItem key={config.id} value={config.name}>
														{config.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>

									<div className="mb-4">
										<div className="font-bold mb-1">协作策略</div>
										<div className="text-[13px] text-vscode-descriptionForeground mb-2">
											控制协调者如何向同事委派工作。
										</div>
										<div className="grid grid-cols-2 gap-4">
											<div>
												<div className="text-xs text-vscode-descriptionForeground mb-1">
													最大递归深度 (maxDepth)
												</div>
												<Input
													type="number"
													min={1}
													value={newModeMaxDepth}
													onChange={(e) => {
														const v = Number(e.target.value)
														setNewModeMaxDepth(
															Number.isFinite(v) && v > 0 ? Math.floor(v) : 3,
														)
													}}
													className="w-full"
												/>
											</div>
											<div>
												<div className="text-xs text-vscode-descriptionForeground mb-1">
													最大重试次数 (maxRetries)
												</div>
												<Input
													type="number"
													min={1}
													value={newModeMaxRetries}
													onChange={(e) => {
														const v = Number(e.target.value)
														setNewModeMaxRetries(
															Number.isFinite(v) && v > 0 ? Math.floor(v) : 3,
														)
													}}
													className="w-full"
												/>
											</div>
										</div>
									</div>

									<div className="mb-4">
										<div className="font-bold mb-1">可委派同事</div>
										<div className="text-[13px] text-vscode-descriptionForeground mb-2">
											勾选该协调者可以委派调用的 Mode（含 hidden 模式）。勾选后将自动在 Role
											Definition 中生成派单说明区块。
										</div>
										<div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
											{modes.map((m) => {
												const checked = selectedSquadMembers.includes(m.slug)
												return (
													<VSCodeCheckbox
														key={m.slug}
														checked={checked}
														onChange={(e: Event | React.FormEvent<HTMLElement>) => {
															const target =
																(e as CustomEvent)?.detail?.target ||
																(e.target as HTMLInputElement)
															const isChecked = target.checked
															const nextMembers = isChecked
																? [...selectedSquadMembers, m.slug]
																: selectedSquadMembers.filter((s) => s !== m.slug)
															setSelectedSquadMembers(nextMembers)
															// Update role definition with squad members section.
															const selectedMemberConfigs = modes.filter((mm) =>
																nextMembers.includes(mm.slug),
															)
															setNewModeRoleDefinition((prev) =>
																updateRoleDefinitionWithSquad(
																	prev,
																	selectedMemberConfigs,
																	newModeMaxRetries,
																),
															)
														}}>
														{m.name}
														<span className="text-xs text-vscode-descriptionForeground ml-1">
															({m.slug})
														</span>
													</VSCodeCheckbox>
												)
											})}
										</div>
									</div>

									<div className="mb-4">
										<VSCodeCheckbox
											checked={newModeHidden}
											onChange={(e: Event | React.FormEvent<HTMLElement>) => {
												const target =
													(e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
												setNewModeHidden(target.checked)
											}}>
											隐藏该模式（hidden）
											<div className="text-xs text-vscode-descriptionForeground mt-0.5">
												开启后该模式不会出现在模式选择器中，但仍可被 new_task 调用。
											</div>
										</VSCodeCheckbox>
									</div>
								</>
							)}

							{/* Workgroup colleague specific fields. */}
							{createModeCategory === "squad" && squadSubType === "member" && (
								<>
									<div className="mb-4">
										<div className="font-bold mb-1">API Profile</div>
										<div className="text-[13px] text-vscode-descriptionForeground mb-2">
											绑定到该模式时激活的 API 配置（可选）。留空表示不绑定。
										</div>
										<Select
											value={newModeApiProfile || "__none__"}
											onValueChange={(v) => setNewModeApiProfile(v === "__none__" ? "" : v)}>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="__none__">不绑定</SelectItem>
												{(listApiConfigMeta || []).map((config) => (
													<SelectItem key={config.id} value={config.name}>
														{config.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>

									<div className="mb-4">
										<VSCodeCheckbox
											checked={newModeHidden}
											onChange={(e: Event | React.FormEvent<HTMLElement>) => {
												const target =
													(e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
												setNewModeHidden(target.checked)
											}}>
											隐藏该模式（hidden，同事默认开启）
											<div className="text-xs text-vscode-descriptionForeground mt-0.5">
												开启后该模式不会出现在模式选择器中，仅由协调者通过 new_task 调用。
											</div>
										</VSCodeCheckbox>
									</div>
								</>
							)}

							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.description.label")}</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.description.description")}
								</div>
								<VSCodeTextField
									value={newModeDescription}
									onChange={(e) => {
										setNewModeDescription((e.target as HTMLInputElement).value)
									}}
									className="w-full"
								/>
								{descriptionError && (
									<div className="text-xs text-vscode-errorForeground mt-1">{descriptionError}</div>
								)}
							</div>

							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.whenToUse.label")}</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.whenToUse.description")}
								</div>
								<VSCodeTextArea
									resize="vertical"
									value={newModeWhenToUse}
									onChange={(e) => {
										setNewModeWhenToUse((e.target as HTMLTextAreaElement).value)
									}}
									rows={3}
									className="w-full"
								/>
							</div>
							{/* Workflow binding: only shown for the "workflow" category. */}
							{createModeCategory === "workflow" && (
								<div className="mb-4">
									<div className="font-bold mb-1">Workflow (Expert type)</div>
									<div className="text-[13px] text-vscode-descriptionForeground mb-2">
										Leave as None for an autonomous expert that drives itself. Pick a workflow to
										make this a workflow-driven expert constrained by that flow.
									</div>
									<Select
										value={newModeWorkflowId || "__none__"}
										onValueChange={(v) => setNewModeWorkflowId(v === "__none__" ? "" : v)}>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="__none__">None (autonomous)</SelectItem>
											{(workflows ?? []).map((wf) => (
												<SelectItem key={wf.id} value={wf.id}>
													{wf.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}
							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.tools.label")}</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.tools.description")}
								</div>
								<div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
									{availableGroups.map((group) => (
										<VSCodeCheckbox
											key={group}
											checked={newModeGroups.some((g) => getGroupName(g) === group)}
											onChange={(e: Event | React.FormEvent<HTMLElement>) => {
												const target =
													(e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
												const checked = target.checked
												if (checked) {
													setNewModeGroups([...newModeGroups, group])
												} else {
													setNewModeGroups(
														newModeGroups.filter((g) => getGroupName(g) !== group),
													)
												}
											}}>
											{t(`prompts:tools.toolNames.${group}`)}
										</VSCodeCheckbox>
									))}
								</div>
								{groupsError && (
									<div className="text-xs text-vscode-errorForeground mt-1">{groupsError}</div>
								)}
							</div>
							<div className="mb-4">
								<div className="font-bold mb-1">
									{t("prompts:createModeDialog.customInstructions.label")}
								</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.customInstructions.description")}
								</div>
								<VSCodeTextArea
									resize="vertical"
									value={newModeCustomInstructions}
									onChange={(e) => {
										setNewModeCustomInstructions((e.target as HTMLTextAreaElement).value)
									}}
									rows={4}
									className="w-full"
								/>
							</div>
						</div>
						<div className="flex justify-end p-3 px-5 gap-2 border-t border-vscode-editor-lineHighlightBorder bg-vscode-editor-background">
							<Button variant="secondary" onClick={() => setIsCreateModeDialogOpen(false)}>
								{t("prompts:createModeDialog.buttons.cancel")}
							</Button>
							<Button variant="primary" onClick={handleCreateMode}>
								{t("prompts:createModeDialog.buttons.create")}
							</Button>
						</div>
					</div>
				</div>
			)}

			{isDialogOpen && (
				<div className="fixed inset-0 flex justify-end bg-black/50 z-[1000]">
					<div className="w-[calc(100vw-100px)] h-full bg-vscode-editor-background shadow-md flex flex-col relative">
						<div className="flex-1 p-5 overflow-y-auto min-h-0">
							<Button
								variant="ghost"
								size="icon"
								onClick={() => setIsDialogOpen(false)}
								className="absolute top-5 right-5">
								<span className="codicon codicon-close"></span>
							</Button>
							<h2 className="mb-4">
								{selectedPromptTitle ||
									t("prompts:systemPrompt.title", {
										modeName: getCurrentMode()?.name || "Code",
									})}
							</h2>
							<pre className="p-2 whitespace-pre-wrap break-words font-mono text-vscode-editor-font-size text-vscode-editor-foreground bg-vscode-editor-background border border-vscode-editor-lineHighlightBorder rounded overflow-y-auto">
								{selectedPromptContent}
							</pre>
						</div>
						<div className="flex justify-end p-3 px-5 border-t border-vscode-editor-lineHighlightBorder bg-vscode-editor-background">
							<Button variant="secondary" onClick={() => setIsDialogOpen(false)}>
								{t("prompts:createModeDialog.close")}
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Import Mode Dialog */}
			{showImportDialog && (
				<div className="fixed inset-0 flex items-center justify-center bg-black/50 z-[1000]">
					<div className="bg-vscode-editor-background border border-vscode-editor-lineHighlightBorder rounded-lg shadow-lg p-6 max-w-md w-full">
						<h3 className="text-lg font-semibold mb-4">{t("prompts:modes.importMode")}</h3>
						<p className="text-sm text-vscode-descriptionForeground mb-4">
							{t("prompts:importMode.selectLevel")}
						</p>
						<div className="space-y-3 mb-6">
							<label className="flex items-start gap-2 cursor-pointer">
								<input
									type="radio"
									name="importLevel"
									value="project"
									className="mt-1"
									checked={importLevel === "project"}
									onChange={() => setImportLevel("project")}
								/>
								<div>
									<div className="font-medium">{t("prompts:importMode.project.label")}</div>
									<div className="text-xs text-vscode-descriptionForeground">
										{t("prompts:importMode.project.description")}
									</div>
								</div>
							</label>
							<label className="flex items-start gap-2 cursor-pointer">
								<input
									type="radio"
									name="importLevel"
									value="global"
									className="mt-1"
									checked={importLevel === "global"}
									onChange={() => setImportLevel("global")}
								/>
								<div>
									<div className="font-medium">{t("prompts:importMode.global.label")}</div>
									<div className="text-xs text-vscode-descriptionForeground">
										{t("prompts:importMode.global.description")}
									</div>
								</div>
							</label>
						</div>
						<div className="flex justify-end gap-2">
							<Button variant="secondary" onClick={() => setShowImportDialog(false)}>
								{t("prompts:createModeDialog.buttons.cancel")}
							</Button>
							<Button
								variant="primary"
								onClick={() => {
									if (!isImporting) {
										setIsImporting(true)
										vscode.postMessage({
											type: "importMode",
											source: importLevel,
										})
									}
								}}
								disabled={isImporting}>
								{isImporting ? t("prompts:importMode.importing") : t("prompts:importMode.import")}
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Delete Mode Confirmation Dialog */}
			<DeleteModeDialog
				open={showDeleteConfirm}
				onOpenChange={setShowDeleteConfirm}
				modeToDelete={modeToDelete}
				onConfirm={() => {
					if (modeToDelete) {
						vscode.postMessage({
							type: "deleteCustomMode",
							slug: modeToDelete.slug,
						})
						setShowDeleteConfirm(false)
						setModeToDelete(null)
					}
				}}
			/>
		</div>
	)
}

export default ModesView
