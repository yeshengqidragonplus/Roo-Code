import * as vscode from "vscode"

/**
 * Global debug-mode state for the Agent Loop step-debugger.
 *
 * Phase 1: this only tracks the on/off flag and mirrors it into the
 * `qcode.debugMode` VS Code context key (which drives the toolbar icon swap
 * between the "enter debug" and "exit debug" buttons — see package.json
 * `view/title` menus). Later phases (DebugController, breakpoints, debug panel)
 * build on top of this flag.
 *
 * See docs/debug-mode-design.md.
 */
class DebugModeState {
	private enabled = false

	public isEnabled(): boolean {
		return this.enabled
	}

	/** Toggle debug mode and return the new value. */
	public async toggle(): Promise<boolean> {
		return this.set(!this.enabled)
	}

	public async set(value: boolean): Promise<boolean> {
		if (this.enabled === value) {
			return this.enabled
		}

		this.enabled = value
		// Drive the `when` clauses that swap the toolbar icon.
		await vscode.commands.executeCommand("setContext", "qcode.debugMode", value)
		return this.enabled
	}
}

/** Process-wide singleton. */
export const debugMode = new DebugModeState()
