import React from "react"
import { Shield, ShieldAlert, ShieldCheck } from "lucide-react"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"

type ApprovalTier = "legacy" | "sandbox" | "full"

export const SandboxModeToggle = ({ forced = false }: { forced?: boolean }) => {
	const { t } = useAppTranslation()
	const {
		autoApprovalMode,
		autoApprovalTier,
		autoApprovalTierEnabled,
		autoApprovalEnabled,
		autoApprovalMinSafetyScore,
	} = useExtensionState()
	const [open, setOpen] = React.useState(false)
	const [confirmFull, setConfirmFull] = React.useState(false)
	const portalContainer = useRooPortal("roo-portal")
	const tier = autoApprovalTier ?? (forced || autoApprovalMode === "sandbox" ? "sandbox" : "legacy")
	const enabled = tier === "legacy" ? !!autoApprovalEnabled : autoApprovalTierEnabled !== false
	const update = (updatedSettings: {
		autoApprovalTier?: ApprovalTier
		autoApprovalTierEnabled?: boolean
		autoApprovalMinSafetyScore?: number
	}) => vscode.postMessage({ type: "updateSettings", updatedSettings })
	const select = (value: ApprovalTier) => {
		if (value === "full" && tier !== "full" && !confirmFull) {
			setConfirmFull(true)
			return
		}
		update({ autoApprovalTier: value, autoApprovalTierEnabled: true })
		setConfirmFull(false)
		setOpen(false)
	}
	const toggle = () => {
		if (tier === "legacy") {
			vscode.postMessage({ type: "autoApprovalEnabled", bool: !autoApprovalEnabled })
		} else {
			update({ autoApprovalTier: tier, autoApprovalTierEnabled: !enabled })
		}
	}
	const Icon = tier === "full" ? ShieldAlert : tier === "sandbox" ? ShieldCheck : Shield
	const label = t("chat:sandboxMode.tierTooltip", {
		tier: t(`chat:sandboxMode.tier.${tier}`),
		state: t(enabled ? "chat:sandboxMode.enabled" : "chat:sandboxMode.disabled"),
	})

	return (
		<Popover
			open={open}
			onOpenChange={(value) => {
				setOpen(value)
				if (!value) setConfirmFull(false)
			}}>
			<StandardTooltip content={label}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={label}
						aria-pressed={enabled}
						onClick={(event) => {
							event.preventDefault()
							toggle()
						}}
						onContextMenu={(event) => {
							event.preventDefault()
							setOpen(true)
						}}
						className={cn(
							"relative inline-flex items-center justify-center bg-transparent border-none p-1.5 rounded-md min-w-[28px] min-h-[28px] hover:bg-[rgba(255,255,255,0.03)] focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder cursor-pointer",
							!enabled
								? "text-vscode-foreground opacity-50"
								: tier === "full"
									? "text-red-400"
									: tier === "sandbox"
										? "text-amber-400"
										: "text-vscode-foreground",
						)}>
						<Icon className="w-4 h-4" />
					</button>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				container={portalContainer}
				align="end"
				className="w-72 p-2"
				onOpenAutoFocus={(event) => event.preventDefault()}>
				<div className="flex flex-col gap-1" role="group" aria-label={t("chat:sandboxMode.chooseTier")}>
					{(["legacy", "sandbox", "full"] as const).map((value) => (
						<button
							key={value}
							type="button"
							aria-pressed={tier === value}
							onClick={() => select(value)}
							className={cn(
								"rounded px-2 py-2 text-left text-sm hover:bg-vscode-list-hoverBackground",
								tier === value && "bg-vscode-list-activeSelectionBackground",
							)}>
							{tier === value ? "✓ " : "　"}
							{t(`chat:sandboxMode.tier.${value}`)}
						</button>
					))}
				</div>
				{tier === "full" && (
					<label className="mt-2 flex items-center justify-between gap-2 text-sm">
						<span>{t("chat:sandboxMode.minimumScore")}</span>
						<select
							aria-label={t("chat:sandboxMode.minimumScore")}
							value={autoApprovalMinSafetyScore ?? 2}
							onChange={(event) => update({ autoApprovalMinSafetyScore: Number(event.target.value) })}
							className="rounded bg-vscode-dropdown-background text-vscode-dropdown-foreground">
							{[0, 1, 2].map((score) => (
								<option key={score} value={score}>
									{score}
								</option>
							))}
						</select>
					</label>
				)}
				{confirmFull && (
					<div className="mt-2 text-sm text-vscode-foreground">
						<p>{t("chat:sandboxMode.fullWarning")}</p>
						<button
							type="button"
							className="rounded bg-vscode-button-background px-2 py-1 text-vscode-button-foreground"
							onClick={() => select("full")}>
							{t("chat:sandboxMode.confirmFull")}
						</button>
					</div>
				)}
			</PopoverContent>
		</Popover>
	)
}
