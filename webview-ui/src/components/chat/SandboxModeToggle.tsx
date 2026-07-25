import React from "react"
import { Shield, ShieldCheck } from "lucide-react"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { StandardTooltip } from "@/components/ui"

/**
 * Session-level "sandbox autonomy" toggle (L1). When on, the backend
 * auto-approves reads/writes inside the workspace and trusted commands, while
 * still asking for anything outside the project, protected files, and unknown
 * commands (see docs/approval-mechanism-design.md and checkAutoApproval).
 *
 * Off (default) leaves the legacy per-category approval behavior untouched.
 */
export const SandboxModeToggle = ({ forced = false }: { forced?: boolean }) => {
	const { t } = useAppTranslation()
	const { autoApprovalMode } = useExtensionState()
	const isOn = forced || autoApprovalMode === "sandbox"

	const toggle = React.useCallback(() => {
		if (forced) return
		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: { autoApprovalMode: isOn ? "manual" : "sandbox" },
		})
	}, [forced, isOn])

	return (
		<StandardTooltip
			content={
				forced
					? "工作群组始终使用安全沙箱审批"
					: isOn
						? t("chat:sandboxMode.tooltipOn")
						: t("chat:sandboxMode.tooltipOff")
			}>
			<button
				aria-label={isOn ? t("chat:sandboxMode.on") : t("chat:sandboxMode.off")}
				aria-pressed={isOn}
				aria-disabled={forced}
				onClick={toggle}
				className={cn(
					"relative inline-flex items-center justify-center",
					"bg-transparent border-none p-1.5",
					"rounded-md min-w-[28px] min-h-[28px]",
					"transition-all duration-150",
					"hover:bg-[rgba(255,255,255,0.03)]",
					"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
					forced ? "cursor-default" : "cursor-pointer",
					isOn ? "text-amber-400 opacity-100" : "text-vscode-foreground opacity-85 hover:opacity-100",
				)}>
				{isOn ? <ShieldCheck className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
			</button>
		</StandardTooltip>
	)
}
