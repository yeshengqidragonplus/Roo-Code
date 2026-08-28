import { useCallback, useEffect, useState } from "react"
import { useKeyPress } from "react-use"
import { AlertDialogProps } from "@radix-ui/react-alert-dialog"

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
} from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { vscode } from "@/utils/vscode"

interface TaskArtifacts {
	taskId: string
	shared: Array<{ hash: string; ext: string; size: number; kind: string; source: string; ts: number }>
	legacyImages: number
	legacyImagesBytes: number
}

interface DeleteTaskDialogProps extends AlertDialogProps {
	taskId: string
	/** Number of subtasks that will also be deleted (for cascade delete warning) */
	subtaskCount?: number
}

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const DeleteTaskDialog = ({ taskId, subtaskCount = 0, ...props }: DeleteTaskDialogProps) => {
	const { t } = useAppTranslation()
	const [isEnterPressed] = useKeyPress("Enter")
	const [artifacts, setArtifacts] = useState<TaskArtifacts | null>(null)
	const [showDetails, setShowDetails] = useState(false)

	const { onOpenChange } = props

	const onDelete = useCallback(() => {
		if (taskId) {
			vscode.postMessage({ type: "deleteTaskWithId", text: taskId })
			onOpenChange?.(false)
		}
	}, [taskId, onOpenChange])

	useEffect(() => {
		if (taskId && isEnterPressed) {
			onDelete()
		}
	}, [taskId, isEnterPressed, onDelete])

	// Request the artifact list when the dialog opens; reset on close.
	useEffect(() => {
		if (props.open && taskId) {
			setShowDetails(false)
			setArtifacts(null)
			vscode.postMessage({ type: "requestTaskArtifacts", text: taskId })
		}
	}, [props.open, taskId])

	// Listen for the host's artifact response.
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message = event.data
			if (message?.type === "taskArtifactsResponse" && message.taskArtifacts?.taskId === taskId) {
				setArtifacts(message.taskArtifacts as TaskArtifacts)
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [taskId])

	// Determine the message to show
	const message =
		subtaskCount > 0 ? t("history:deleteWithSubtasks", { count: subtaskCount }) : t("history:deleteTaskMessage")

	const sharedCount = artifacts?.shared.length ?? 0
	const hasArtifacts = sharedCount > 0 || (artifacts?.legacyImages ?? 0) > 0

	return (
		<AlertDialog {...props}>
			<AlertDialogContent onEscapeKeyDown={() => onOpenChange?.(false)}>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("history:deleteTask")}</AlertDialogTitle>
					<AlertDialogDescription>{message}</AlertDialogDescription>
				</AlertDialogHeader>
				{hasArtifacts && (
					<div className="text-sm">
						<button
							type="button"
							className="text-vscode-textLink underline cursor-pointer bg-transparent border-none p-0"
							onClick={() => setShowDetails((v) => !v)}>
							{showDetails
								? t("history:artifacts.hideDetails")
								: t("history:artifacts.viewDetails", { count: sharedCount + (artifacts?.legacyImages ?? 0) })}
						</button>
						{showDetails && artifacts && (
							<div className="mt-2 border border-vscode-editorWidget-border rounded p-2 max-h-48 overflow-y-auto">
								{sharedCount > 0 && (
									<div className="mb-2">
										<div className="text-vscode-descriptionForeground mb-1">
											{t("history:artifacts.sharedFiles", { count: sharedCount })}
										</div>
										<ul className="list-none p-0 m-0">
											{artifacts.shared.map((entry) => (
												<li key={entry.hash} className="flex justify-between gap-2 py-0.5">
													<span className="font-mono text-xs truncate">
														{entry.hash.slice(0, 12)}….{entry.ext}
													</span>
													<span className="text-vscode-descriptionForeground text-xs whitespace-nowrap">
														{formatBytes(entry.size)} · {entry.source}
													</span>
												</li>
											))}
										</ul>
										<div className="text-vscode-descriptionForeground text-xs mt-1">
											{t("history:artifacts.sharedGcHint")}
										</div>
									</div>
								)}
								{(artifacts?.legacyImages ?? 0) > 0 && (
									<div>
										<div className="text-vscode-descriptionForeground">
											{t("history:artifacts.legacyImages", {
												count: artifacts!.legacyImages,
												size: formatBytes(artifacts!.legacyImagesBytes),
											})}
										</div>
									</div>
								)}
							</div>
						)}
					</div>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="secondary">{t("history:cancel")}</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button variant="destructive" onClick={onDelete}>
							{t("history:delete")}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
