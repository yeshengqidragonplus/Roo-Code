import { VSCodeCheckbox, VSCodeTextField, VSCodeRadioGroup, VSCodeRadio } from "@vscode/webview-ui-toolkit/react"
import { useAppTranslation } from "@/i18n/TranslationContext"

interface WebSearchSettingsProps {
	enabled: boolean
	onChange: (enabled: boolean) => void
	tavilyApiKey?: string
	setTavilyApiKey: (apiKey: string) => void
	googleApiKey?: string
	setGoogleApiKey: (apiKey: string) => void
	googleCseId?: string
	setGoogleCseId: (cseId: string) => void
	webSearchProvider?: "tavily" | "google" | "auto"
	setWebSearchProvider: (provider: "tavily" | "google" | "auto") => void
}

export const WebSearchSettings = ({
	enabled,
	onChange,
	tavilyApiKey,
	setTavilyApiKey,
	googleApiKey,
	setGoogleApiKey,
	googleCseId,
	setGoogleCseId,
	webSearchProvider,
	setWebSearchProvider,
}: WebSearchSettingsProps) => {
	const { t } = useAppTranslation()

	const tavilyConfigured = !!tavilyApiKey
	const googleConfigured = !!googleApiKey && !!googleCseId
	const isConfigured = tavilyConfigured || googleConfigured

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
				<div className="ml-2 space-y-4">
					{/* Backend provider selection */}
					<div>
						<label className="block font-medium mb-1">Search Provider</label>
						<VSCodeRadioGroup
							value={webSearchProvider || "auto"}
							onChange={(e: any) => setWebSearchProvider(e.target.value)}>
							<VSCodeRadio value="auto" name="web-search-provider">
								Auto (prefer Google if configured, else Tavily)
							</VSCodeRadio>
							<VSCodeRadio value="tavily" name="web-search-provider">
								Tavily
							</VSCodeRadio>
							<VSCodeRadio value="google" name="web-search-provider">
								Google Custom Search
							</VSCodeRadio>
						</VSCodeRadioGroup>
					</div>

					{/* Tavily credentials */}
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

					{/* Google Custom Search credentials */}
					<div>
						<label className="block font-medium mb-1">Google API Key</label>
						<VSCodeTextField
							value={googleApiKey || ""}
							onInput={(e: any) => setGoogleApiKey(e.target.value)}
							placeholder="AIza..."
							className="w-full"
							type="password"
						/>
						<p className="text-vscode-descriptionForeground text-xs mt-1">
							Get a key at{" "}
							<a
								href="https://console.cloud.google.com/apis/credentials"
								target="_blank"
								rel="noopener noreferrer"
								className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground">
								Google Cloud Console
							</a>
						</p>
					</div>

					<div>
						<label className="block font-medium mb-1">Google Search Engine ID (cx)</label>
						<VSCodeTextField
							value={googleCseId || ""}
							onInput={(e: any) => setGoogleCseId(e.target.value)}
							placeholder="e.g. 012345678901234567891:abcdefg"
							className="w-full"
						/>
						<p className="text-vscode-descriptionForeground text-xs mt-1">
							Create a Custom Search Engine at{" "}
							<a
								href="https://programmablesearchengine.google.com/"
								target="_blank"
								rel="noopener noreferrer"
								className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground">
								programmablesearchengine.google.com
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
							{tavilyConfigured && googleConfigured
								? "Both Tavily and Google are configured. Provider selection above decides which to use."
								: tavilyConfigured
									? "Tavily is configured. Set Google credentials to enable Google as an option."
									: "Google is configured. Set a Tavily API key to enable Tavily as an option."}
						</div>
					)}
				</div>
			)}
		</div>
	)
}

