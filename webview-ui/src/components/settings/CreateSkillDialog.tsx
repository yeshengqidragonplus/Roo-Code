import React, { useState, useCallback } from "react"
import { validateSkillName as validateSkillNameShared, SkillNameValidationError } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Textarea,
} from "@/components/ui"
import { vscode } from "@/utils/vscode"

interface CreateSkillDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onSkillCreated: () => void
	hasWorkspace: boolean
}

/**
 * Map skill name validation error codes to translation keys.
 */
const getSkillNameErrorTranslationKey = (error: SkillNameValidationError): string => {
	switch (error) {
		case SkillNameValidationError.Empty:
			return "settings:skills.validation.nameRequired"
		case SkillNameValidationError.TooLong:
			return "settings:skills.validation.nameTooLong"
		case SkillNameValidationError.InvalidFormat:
			return "settings:skills.validation.nameInvalid"
	}
}

/**
 * Validate skill name using shared validation from @roo-code/types.
 * Returns a translation key for the error, or null if valid.
 */
const validateSkillName = (name: string): string | null => {
	const result = validateSkillNameShared(name)
	if (!result.valid) {
		return getSkillNameErrorTranslationKey(result.error!)
	}
	return null
}

/**
 * Validate description according to agentskills.io spec:
 * - Required field
 * - 1-1024 characters
 */
const validateDescription = (description: string): string | null => {
	if (!description) return "settings:skills.validation.descriptionRequired"
	if (description.length > 1024) return "settings:skills.validation.descriptionTooLong"
	return null
}

export const CreateSkillDialog: React.FC<CreateSkillDialogProps> = ({
	open,
	onOpenChange,
	onSkillCreated,
	hasWorkspace,
}) => {
	const { t } = useAppTranslation()
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")
	const [source, setSource] = useState<"global" | "project">(hasWorkspace ? "project" : "global")
	const [nameError, setNameError] = useState<string | null>(null)
	const [descriptionError, setDescriptionError] = useState<string | null>(null)

	const resetForm = useCallback(() => {
		setName("")
		setDescription("")
		setSource(hasWorkspace ? "project" : "global")
		setNameError(null)
		setDescriptionError(null)
	}, [hasWorkspace])

	const handleClose = useCallback(() => {
		resetForm()
		onOpenChange(false)
	}, [resetForm, onOpenChange])

	const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")
		setName(value)
		setNameError(null)
	}, [])

	const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setDescription(e.target.value)
		setDescriptionError(null)
	}, [])

	const handleCreate = useCallback(() => {
		// Validate fields
		const nameValidationError = validateSkillName(name)
		const descValidationError = validateDescription(description)

		if (nameValidationError) {
			setNameError(nameValidationError)
			return
		}

		if (descValidationError) {
			setDescriptionError(descValidationError)
			return
		}

		// Mode-owned Skill assignment is configured from the Mode settings page.
		// New Skills are globally executable through slash commands by default.
		vscode.postMessage({
			type: "createSkill",
			skillName: name,
			source,
			skillDescription: description,
		})

		// Close dialog and notify parent
		handleClose()
		onSkillCreated()
	}, [name, description, source, handleClose, onSkillCreated])

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("settings:skills.createDialog.title")}</DialogTitle>
					<DialogDescription></DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					{/* Name Input */}
					<div className="flex flex-col gap-1">
						<label htmlFor="skill-name" className="text-sm font-medium text-vscode-foreground">
							{t("settings:skills.createDialog.nameLabel")}
						</label>
						<Input
							id="skill-name"
							type="text"
							value={name}
							onChange={handleNameChange}
							placeholder={t("settings:skills.createDialog.namePlaceholder")}
							maxLength={64}
							className="w-full bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded-xl px-3 py-2 focus:outline-none focus:border-vscode-focusBorder"
						/>
						{nameError && <span className="text-xs text-vscode-errorForeground">{t(nameError)}</span>}
					</div>

					{/* Description Input */}
					<div className="flex flex-col gap-1">
						<Textarea
							id="skill-description"
							value={description}
							onChange={handleDescriptionChange}
							placeholder={t("settings:skills.createDialog.descriptionPlaceholder")}
							maxLength={1024}
							rows={5}
						/>
						{descriptionError && (
							<span className="text-xs text-vscode-errorForeground">{t(descriptionError)}</span>
						)}
					</div>

					{/* Source Selection */}
					<div className="flex flex-col gap-1">
						<label className="text-sm font-medium text-vscode-foreground">
							{t("settings:skills.createDialog.sourceLabel")}
						</label>
						<Select value={source} onValueChange={(value) => setSource(value as "global" | "project")}>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="global">{t("settings:skills.source.global")}</SelectItem>
								{hasWorkspace && (
									<SelectItem value="project">{t("settings:skills.source.project")}</SelectItem>
								)}
							</SelectContent>
						</Select>
					</div>
				</div>

				<DialogFooter>
					<Button variant="secondary" onClick={handleClose}>
						{t("settings:skills.createDialog.cancel")}
					</Button>
					<Button variant="primary" onClick={handleCreate} disabled={!name || !description}>
						{t("settings:skills.createDialog.create")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
