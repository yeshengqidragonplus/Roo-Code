import * as vscode from "vscode"

import { getNonce } from "../webview/getNonce"
import { getUri } from "../webview/getUri"
import { debugMode } from "./debugMode"
import { debugController, type DebugResumeResult } from "./DebugController"

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
			(message: { type?: string; result?: DebugResumeResult }) => {
				switch (message?.type) {
					case "debugReady":
						this.postMessage({ type: "debugModeChanged", enabled: debugMode.isEnabled() })
						break
					case "debugContinue":
					case "debugStep":
						// `result` carries only the fields the user actually edited;
						// unedited fields are absent and the loop keeps its originals.
						debugController.resume(message.result ?? {})
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
		summary { padding: 6px 10px; cursor: pointer; user-select: none; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 6px; }
		summary .badge { font-size: 11px; padding: 0 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
		.body { padding: 8px 10px; }
		.note { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 0 0 6px; }
		textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 48px; padding: 8px; white-space: pre; overflow: auto; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
		textarea[readonly] { background: transparent; border-color: transparent; resize: none; color: var(--vscode-foreground); opacity: 0.85; }
		textarea.placeholder { color: var(--vscode-descriptionForeground); font-style: italic; }
		textarea.invalid { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
		.errbar { display: none; margin: 8px 12px 0; padding: 6px 10px; border-radius: 2px; background: var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.15)); color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100); font-size: 12px; }
		.errbar.show { display: block; }
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
	<div id="errbar" class="errbar"></div>
	<div class="sections">
		<details open data-section="systemPrompt"><summary>System Prompt<span class="badge" hidden>editable</span></summary><div class="body"><textarea id="systemPrompt" data-field="systemPrompt" data-kind="text" readonly></textarea></div></details>
		<details data-section="messages"><summary>Messages<span class="badge" hidden>editable</span></summary><div class="body"><p class="note" hidden>Edits here apply to this request only — they are not written back to the conversation history.</p><textarea id="messages" data-field="messages" data-kind="json" readonly></textarea></div></details>
		<details data-section="metadata"><summary>Metadata<span class="badge" hidden>editable</span></summary><div class="body"><textarea id="metadata" data-field="metadata" data-kind="json" readonly></textarea></div></details>
		<details data-section="assistant"><summary>Assistant Reply<span class="badge" hidden>editable</span></summary><div class="body"><textarea id="assistant" data-field="assistantText" data-kind="text" readonly></textarea></div></details>
		<details data-section="tool"><summary>Pending Tool<span class="badge" hidden>editable</span></summary><div class="body"><p class="note" hidden>Only the tool <code>input</code> is applied — editing the tool <code>name</code> has no effect.</p><textarea id="tool" data-field="tool" data-kind="json" readonly></textarea></div></details>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		const continueBtn = $("continue");
		const stepBtn = $("step");
		const errbar = $("errbar");

		const STAGE_LABELS = { beforeRequest: "Before Request", afterResponse: "After Response", beforeTool: "Before Tool" };
		// Which sections are editable at each stage (the rest are read-only).
		const EDITABLE = {
			beforeRequest: ["systemPrompt", "messages", "metadata"],
			afterResponse: ["assistant"],
			beforeTool: ["tool"],
		};
		const SECTIONS = ["systemPrompt", "messages", "metadata", "assistant", "tool"];

		// Original (server-sent) string per section, to detect real edits.
		const original = {};

		function asText(v) {
			if (v === undefined || v === null) return null;
			if (typeof v === "string") return v;
			try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
		}

		function setSection(id, value) {
			const el = $(id);
			const text = asText(value);
			if (text === null) {
				el.value = "";
				el.placeholder = "—";
				el.classList.add("placeholder");
				original[id] = null;
			} else {
				el.value = text;
				el.classList.remove("placeholder");
				original[id] = text;
			}
			el.classList.remove("invalid");
		}

		function applyEditability(stage) {
			const editable = EDITABLE[stage] || [];
			SECTIONS.forEach((id) => {
				const el = $(id);
				const isEditable = editable.indexOf(id) !== -1 && original[id] !== null;
				el.readOnly = !isEditable;
				const details = el.closest("details");
				const badge = details.querySelector(".badge");
				if (badge) badge.hidden = !isEditable;
				const note = details.querySelector(".note");
				if (note) note.hidden = !isEditable;
				if (isEditable) details.open = true;
			});
		}

		function setPaused(paused) {
			continueBtn.disabled = !paused;
			stepBtn.disabled = !paused;
		}

		function clearError() { errbar.classList.remove("show"); errbar.textContent = ""; }
		function showError(msg) { errbar.textContent = msg; errbar.classList.add("show"); }

		function onPaused(payload) {
			payload = payload || {};
			clearError();
			$("stage").textContent = STAGE_LABELS[payload.stage] || payload.stage || "Paused";
			$("meta").textContent = payload.taskId ? ("task " + payload.taskId) : "";
			setSection("systemPrompt", payload.systemPrompt);
			setSection("messages", payload.messages);
			setSection("metadata", payload.metadata);
			setSection("assistant", payload.assistantText);
			setSection("tool", payload.tool);
			applyEditability(payload.stage);
			setPaused(true);
		}

		function onResumed() {
			$("stage").textContent = "Running…";
			$("meta").textContent = "";
			clearError();
			setPaused(false);
		}

		// Gather only the sections the user actually changed; parse JSON ones.
		// Returns { result } on success, or { error } if any JSON is invalid.
		function collectResult() {
			const result = {};
			SECTIONS.forEach((id) => $(id).classList.remove("invalid"));
			for (const id of SECTIONS) {
				const el = $(id);
				if (el.readOnly || original[id] === null) continue;
				const value = el.value;
				if (value === original[id]) continue; // unchanged
				const field = el.dataset.field;
				if (el.dataset.kind === "json") {
					try {
						result[field] = JSON.parse(value);
					} catch (e) {
						el.classList.add("invalid");
						return { error: "Invalid JSON in \\"" + id + "\\": " + e.message };
					}
				} else {
					result[field] = value;
				}
			}
			return { result };
		}

		function resume(type) {
			const { result, error } = collectResult();
			if (error) { showError(error); return; }
			clearError();
			setPaused(false);
			vscode.postMessage({ type, result });
		}

		continueBtn.addEventListener("click", () => resume("debugContinue"));
		stepBtn.addEventListener("click", () => resume("debugStep"));

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
