import React, { useState, useEffect, useMemo, useCallback } from "react"
import { Trans } from "react-i18next"
import { Plus, Globe, Folder, Edit, Trash2 } from "lucide-react"

import type { SkillMetadata } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
	StandardTooltip,
} from "@/components/ui"
import { vscode } from "@/utils/vscode"
import { buildDocLink } from "@/utils/docLinks"

import { SectionHeader } from "./SectionHeader"
import { CreateSkillDialog } from "./CreateSkillDialog"

export const SkillsSettings: React.FC = () => {
	const { t } = useAppTranslation()
	const { cwd, skills: rawSkills } = useExtensionState()
	const skills = useMemo(() => rawSkills ?? [], [rawSkills])

	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
	const [skillToDelete, setSkillToDelete] = useState<SkillMetadata | null>(null)
	const [createDialogOpen, setCreateDialogOpen] = useState(false)

	// Check if we're in a workspace/project
	const hasWorkspace = Boolean(cwd)

	const handleRefresh = useCallback(() => {
		vscode.postMessage({ type: "requestSkills" })
	}, [])

	// Request skills when component mounts
	useEffect(() => {
		handleRefresh()
	}, [handleRefresh])

	const handleDeleteClick = useCallback((skill: SkillMetadata) => {
		setSkillToDelete(skill)
		setDeleteDialogOpen(true)
	}, [])

	const handleDeleteConfirm = useCallback(() => {
		if (skillToDelete) {
			vscode.postMessage({
				type: "deleteSkill",
				skillName: skillToDelete.name,
				source: skillToDelete.source,
				skillModeSlugs: skillToDelete.modeSlugs,
			})
			setDeleteDialogOpen(false)
			setSkillToDelete(null)
		}
	}, [skillToDelete])

	const handleDeleteCancel = useCallback(() => {
		setDeleteDialogOpen(false)
		setSkillToDelete(null)
	}, [])

	const handleEditClick = useCallback((skill: SkillMetadata) => {
		vscode.postMessage({
			type: "openSkillFile",
			skillName: skill.name,
			source: skill.source,
			skillModeSlugs: skill.modeSlugs,
		})
	}, [])

	// No-op callback - the backend sends updated skills list via ExtensionStateContext
	const handleSkillCreated = useCallback(() => {}, [])

	// Group skills by source
	const projectSkills = useMemo(() => skills.filter((skill) => skill.source === "project"), [skills])
	const globalSkills = useMemo(() => skills.filter((skill) => skill.source === "global"), [skills])

	// Render a single skill item
	const renderSkillItem = useCallback(
		(skill: SkillMetadata) => {
			return (
				<div key={`${skill.source}-${skill.name}`} className="p-2.5 px-2 rounded-xl border border-transparent">
					<div className="flex items-start justify-between gap-2 flex-col min-[400px]:flex-row overflow-hidden">
						<div className="flex-1 min-w-0">
							{/* Skill name */}
							<div className="flex items-center gap-2 overflow-hidden">
								<span className="font-medium truncate">{skill.name}</span>
							</div>
							{/* Skill description */}
							{skill.description && (
								<div className="text-xs text-vscode-descriptionForeground mt-1 line-clamp-3">
									{skill.description}
								</div>
							)}
						</div>

						{/* Actions */}
						<div className="flex items-center gap-1 px-0 ml-0 min-[400px]:ml-0 min-[400px]:mt-4 flex-shrink-0">
							<StandardTooltip content={t("settings:skills.editSkill")}>
								<Button variant="ghost" size="icon" onClick={() => handleEditClick(skill)}>
									<Edit />
								</Button>
							</StandardTooltip>

							<StandardTooltip content={t("settings:skills.deleteSkill")}>
								<Button variant="ghost" size="icon" onClick={() => handleDeleteClick(skill)}>
									<Trash2 className="text-destructive" />
								</Button>
							</StandardTooltip>
						</div>
					</div>
				</div>
			)
		},
		[t, handleEditClick, handleDeleteClick],
	)

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Fixed Header */}
			<div className="flex-shrink-0">
				<SectionHeader>{t("settings:sections.skills")}</SectionHeader>
				<div className="flex flex-col gap-2 px-5 py-2">
					<p className="text-vscode-descriptionForeground text-sm m-0">
						<Trans
							i18nKey="settings:skills.description"
							components={{
								DocsLink: (
									<a
										href={buildDocLink("features/skills", "skills_settings")}
										target="_blank"
										rel="noopener noreferrer"
										className="text-vscode-textLink-foreground hover:underline">
										Docs
									</a>
								),
							}}
						/>
					</p>

					{/* Add Skill button */}
					<Button variant="secondary" className="py-1" onClick={() => setCreateDialogOpen(true)}>
						<Plus />
						{t("settings:skills.addSkill")}
					</Button>
				</div>
			</div>

			{/* Scrollable List Area */}
			<div className="flex-1 overflow-y-auto px-4 py-2 min-h-0">
				<div className="flex flex-col gap-1">
					{/* Project Skills Section - Only show if in a workspace */}
					{hasWorkspace && (
						<>
							<div className="flex items-center gap-2 px-2 py-2 mt-2 cursor-default">
								<Folder className="size-4 shrink-0" />
								<span className="font-medium text-lg">{t("settings:skills.workspaceSkills")}</span>
							</div>
							{projectSkills.length > 0 ? (
								projectSkills.map(renderSkillItem)
							) : (
								<div className="px-2 pb-4 text-sm text-vscode-descriptionForeground cursor-default">
									{t("settings:skills.noWorkspaceSkills")}
								</div>
							)}
						</>
					)}

					{/* Global Skills Section */}
					<div className="flex items-center gap-2 px-2 py-2 mt-2 cursor-default">
						<Globe className="size-4 shrink-0" />
						<span className="font-medium text-lg">{t("settings:skills.globalSkills")}</span>
					</div>
					{globalSkills.length > 0 ? (
						globalSkills.map(renderSkillItem)
					) : (
						<div className="px-2 pb-4 text-sm text-vscode-descriptionForeground cursor-default">
							{t("settings:skills.noGlobalSkills")}
						</div>
					)}
				</div>
			</div>

			{/* Delete Confirmation Dialog */}
			<AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("settings:skills.deleteDialog.title")}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:skills.deleteDialog.description", { name: skillToDelete?.name })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={handleDeleteCancel}>
							{t("settings:skills.deleteDialog.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={handleDeleteConfirm}>
							{t("settings:skills.deleteDialog.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Create Skill Dialog */}
			<CreateSkillDialog
				open={createDialogOpen}
				onOpenChange={setCreateDialogOpen}
				onSkillCreated={handleSkillCreated}
				hasWorkspace={hasWorkspace}
			/>
		</div>
	)
}
