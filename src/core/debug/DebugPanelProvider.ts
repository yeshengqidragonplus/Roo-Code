import * as vscode from "vscode"

import { getNonce } from "../webview/getNonce"
import { getUri } from "../webview/getUri"
import { debugMode } from "./debugMode"
import { debugController } from "./DebugController"

/**
 * Hosts the Agent Loop step-debugger panel in its own editor tab.
 *
 * Phase 2: opens a self-contained webview (plain HTML + a tiny message bridge)
 * showing an empty skeleton — sections for stage / system prompt / messages /
 * metadata / assistant reply / pending tool, plus a Continue/Step/Edit action
 * bar. No live data is wired yet; the breakpoint plumbing (DebugController) and
 * the editable UI land in phases 3 and 4.
 *
 * Deliberately NOT a second React/Vite build: the panel's needs are modest
 * (render JSON, a few buttons), so a lightweight hand-written webview keeps the
 * feature self-contained and avoids reconfiguring the webview-ui bundle.
 *
 * See docs/debug-mode-design.md.
 */
export class DebugPanelProvider {
	public static readonly viewType = "qcode.DebugPanel"
	private static current?: DebugPanelProvider

	private readonly panel: vscode.WebviewPanel
	private readonly disposables: vscode.Disposable[] = []

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this.panel = panel
		this.panel.webview.html = this.getHtml(this.panel.webview, extensionUri)

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables)

		this.panel.webview.onDidReceiveMessage(
			(message: { type?: string }) => {
				switch (message?.type) {
					case "debugReady":
						this.postMessage({ type: "debugModeChanged", enabled: debugMode.isEnabled() })
						break
					case "debugContinue":
					case "debugStep":
						// Phase 4 will carry edited fields on these messages.
						debugController.resume()
						break
				}
			},
			null,
			this.disposables,
		)
	}

	/** Open the panel beside the active editor, or reveal it if already open. */
	public static createOrShow(extensionUri: vscode.Uri): DebugPanelProvider {
		if (DebugPanelProvider.current) {
			DebugPanelProvider.current.panel.reveal(vscode.ViewColumn.Beside)
			return DebugPanelProvider.current
		}

		const panel = vscode.window.createWebviewPanel(
			DebugPanelProvider.viewType,
			"QCode Debug",
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri],
			},
		)

		DebugPanelProvider.current = new DebugPanelProvider(panel, extensionUri)
		return DebugPanelProvider.current
	}

	/** Close the panel if open (e.g. when leaving debug mode). */
	public static close(): void {
		DebugPanelProvider.current?.panel.dispose()
	}

	public static get instance(): DebugPanelProvider | undefined {
		return DebugPanelProvider.current
	}

	public postMessage(message: unknown): void {
		void this.panel.webview.postMessage(message)
	}

	private dispose(): void {
		DebugPanelProvider.current = undefined
		while (this.disposables.length) {
			this.disposables.pop()?.dispose()
		}
		this.panel.dispose()
		// Release any breakpoint the loop is blocked on so it never hangs, then
		// turn off debug mode (closing the panel implies leaving debug mode).
		debugController.cancelAll()
		void debugMode.set(false)
	}

	private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		const nonce = getNonce()
		const codiconsUri = getUri(webview, extensionUri, ["assets", "codicons", "codicon.css"])
		const csp = [
			`default-src 'none'`,
			`font-src ${webview.cspSource}`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`img-src ${webview.cspSource} data:`,
			`script-src 'nonce-${nonce}'`,
		].join("; ")

		return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<link href="${codiconsUri}" rel="stylesheet" />
	<title>QCode Debug</title>
	<style nonce="${nonce}">
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; }
		.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editor-background); }
		.stage { font-weight: 600; }
		.stage .muted { font-weight: 400; color: var(--vscode-descriptionForeground); margin-left: 8px; }
		.actions { margin-left: auto; display: flex; gap: 6px; }
		button { font-family: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
		button:disabled { opacity: 0.5; cursor: default; }
		button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		.sections { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
		details { border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
		summary { padding: 6px 10px; cursor: pointer; user-select: none; color: var(--vscode-descriptionForeground); }
		pre { margin: 0; padding: 10px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
		.placeholder { color: var(--vscode-descriptionForeground); font-style: italic; }
	</style>
</head>
<body>
	<div class="toolbar">
		<span class="stage"><span class="codicon codicon-bug"></span> <span id="stage">Idle</span><span class="muted" id="meta"></span></span>
		<div class="actions">
			<button id="continue" disabled><span class="codicon codicon-debug-continue"></span> Continue</button>
			<button id="step" class="secondary" disabled><span class="codicon codicon-debug-step-over"></span> Step</button>
		</div>
	</div>
	<div class="sections">
		<details open><summary>System Prompt</summary><pre id="systemPrompt" class="placeholder">— (waiting for a breakpoint)</pre></details>
		<details><summary>Messages</summary><pre id="messages" class="placeholder">—</pre></details>
		<details><summary>Metadata</summary><pre id="metadata" class="placeholder">—</pre></details>
		<details><summary>Assistant Reply</summary><pre id="assistant" class="placeholder">—</pre></details>
		<details><summary>Pending Tool</summary><pre id="tool" class="placeholder">—</pre></details>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		const continueBtn = $("continue");
		const stepBtn = $("step");

		const STAGE_LABELS = { beforeRequest: "Before Request", afterResponse: "After Response", beforeTool: "Before Tool" };

		function asText(v) {
			if (v === undefined || v === null) return null;
			if (typeof v === "string") return v;
			try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
		}

		function setSection(id, value) {
			const el = $(id);
			const text = asText(value);
			if (text === null) {
				el.textContent = "—";
				el.classList.add("placeholder");
			} else {
				el.textContent = text;
				el.classList.remove("placeholder");
			}
		}

		function setPaused(paused) {
			continueBtn.disabled = !paused;
			stepBtn.disabled = !paused;
		}

		function onPaused(payload) {
			payload = payload || {};
			$("stage").textContent = STAGE_LABELS[payload.stage] || payload.stage || "Paused";
			$("meta").textContent = payload.taskId ? ("task " + payload.taskId) : "";
			setSection("systemPrompt", payload.systemPrompt);
			setSection("messages", payload.messages);
			setSection("metadata", payload.metadata);
			setSection("assistant", payload.assistantText);
			setSection("tool", payload.tool);
			setPaused(true);
		}

		function onResumed() {
			$("stage").textContent = "Running…";
			$("meta").textContent = "";
			setPaused(false);
		}

		continueBtn.addEventListener("click", () => { setPaused(false); vscode.postMessage({ type: "debugContinue" }); });
		stepBtn.addEventListener("click", () => { setPaused(false); vscode.postMessage({ type: "debugStep" }); });

		window.addEventListener("message", (event) => {
			const msg = event.data || {};
			if (msg.type === "debugPaused") onPaused(msg.payload);
			else if (msg.type === "debugResumed") onResumed();
		});

		// Tell the host we are ready to receive breakpoints.
		vscode.postMessage({ type: "debugReady" });
	</script>
</body>
</html>`
	}
}
