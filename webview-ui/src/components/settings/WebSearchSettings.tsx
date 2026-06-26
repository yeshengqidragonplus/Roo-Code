import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useAppTranslation } from "@/i18n/TranslationContext"

interface WebSearchSettingsProps {
	enabled: boolean
	onChange: (enabled: boolean) => void
	tavilyApiKey?: string
	setTavilyApiKey: (apiKey: string) => void
}

export const WebSearchSettings = ({ enabled, onChange, tavilyApiKey, setTavilyApiKey }: WebSearchSettingsProps) => {
	const { t } = useAppTranslation()

	const isConfigured = !!tavilyApiKey

	return (
		<div className="space-y-4">
			<div>
				<div className="flex items-center gap-2">
					<VSCodeCheckbox checked={enabled} onChange={(e: any) => onChange(e.target.checked)}>
						<span className="font-medium">{t("settings:experimental.WEB_SEARCH.name")}</span>
					</VSCodeCheckbox>
				</div>
				<p className="text-vscode-descriptionForeground text-sm mt-0">
					{t("settings:experimental.WEB_SEARCH.description")}
				</p>
			</div>

			{enabled && (
				<div className="ml-2 space-y-3">
					<div>
						<label className="block font-medium mb-1">
							{t("settings:experimental.WEB_SEARCH.tavilyApiKeyLabel")}
						</label>
						<VSCodeTextField
							value={tavilyApiKey || ""}
							onInput={(e: any) => setTavilyApiKey(e.target.value)}
							placeholder={t("settings:experimental.WEB_SEARCH.tavilyApiKeyPlaceholder")}
							className="w-full"
							type="password"
						/>
						<p className="text-vscode-descriptionForeground text-xs mt-1">
							{t("settings:experimental.WEB_SEARCH.getApiKeyText")}{" "}
							<a
								href="https://tavily.com"
								target="_blank"
								rel="noopener noreferrer"
								className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground">
								tavily.com
							</a>
						</p>
					</div>

					{!isConfigured && (
						<div className="p-2 bg-vscode-editorWarning-background text-vscode-editorWarning-foreground rounded text-sm">
							{t("settings:experimental.WEB_SEARCH.warningMissingKey")}
						</div>
					)}

					{isConfigured && (
						<div className="p-2 bg-vscode-editorInfo-background text-vscode-editorInfo-foreground rounded text-sm">
							{t("settings:experimental.WEB_SEARCH.successConfigured")}
						</div>
					)}
				</div>
			)}
		</div>
	)
}
