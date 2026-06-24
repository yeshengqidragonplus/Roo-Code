import * as fs from "fs/promises"
import * as path from "path"

import { getGlobalRooDirectory } from "../../services/roo-config"

/**
 * Discovery metadata for a workflow JSON file. The `id` (filename without
 * extension) is the stable reference stored in an expert's
 * `workflow.workflowId`; `name`/`description` are display-only (read from the
 * JSON) and may change without breaking the reference.
 */
export interface WorkflowSummary {
	id: string
	name: string
	description: string
	source: "global" | "project"
	path: string
}

/** Workflow ids follow the same slug rule as skills/mode slugs. */
const WORKFLOW_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Standard workflow directories, lowest precedence first. Project workflows
 * override global ones of the same id (scanned later → win on Map.set).
 */
export function getWorkflowDirectories(cwd?: string): Array<{ dir: string; source: "global" | "project" }> {
	const dirs: Array<{ dir: string; source: "global" | "project" }> = [
		{ dir: path.join(getGlobalRooDirectory(), "workflows"), source: "global" },
	]
	if (cwd) {
		dirs.push({ dir: path.join(cwd, ".roo", "workflows"), source: "project" })
	}
	return dirs
}

/**
 * Discovers workflow JSON files from a set of directories and loads them by id.
 * Decoupled from any provider/cwd for testability: callers pass directories
 * (use getWorkflowDirectories for the standard set).
 */
export class WorkflowRegistry {
	private workflows = new Map<string, WorkflowSummary>()

	constructor(
		private readonly dirs: Array<{ dir: string; source: "global" | "project" }>,
		private readonly warn: (msg: string) => void = () => {},
	) {}

	/** (Re)scan all directories. Project entries override global ones by id. */
	async discover(): Promise<void> {
		this.workflows.clear()
		for (const { dir, source } of this.dirs) {
			await this.scanDir(dir, source)
		}
	}

	private async scanDir(dir: string, source: "global" | "project"): Promise<void> {
		let entries: string[]
		try {
			entries = await fs.readdir(dir)
		} catch {
			return // directory absent — fine
		}

		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue
			const id = entry.slice(0, -".json".length)
			if (!WORKFLOW_ID_REGEX.test(id)) {
				this.warn(`Skipping workflow with invalid id "${id}" (must be a lowercase-hyphen slug)`)
				continue
			}

			const filePath = path.join(dir, entry)
			let name = id
			let description = ""
			try {
				const json = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>
				if (typeof json.name === "string" && json.name) name = json.name
				if (typeof json.description === "string") description = json.description
			} catch {
				this.warn(`Skipping workflow "${id}": not valid JSON (${filePath})`)
				continue
			}

			this.workflows.set(id, { id, name, description, source, path: filePath })
		}
	}

	/** All discovered workflows (for the expert-creation UI dropdown). */
	list(): WorkflowSummary[] {
		return [...this.workflows.values()]
	}

	/** Summary for a single workflow id, or undefined if unknown. */
	get(id: string): WorkflowSummary | undefined {
		return this.workflows.get(id)
	}

	/** Read + parse the full workflow graph JSON for `id` (to feed the engine). */
	async load(id: string): Promise<unknown> {
		const summary = this.workflows.get(id)
		if (!summary) {
			throw new Error(`Workflow not found: "${id}"`)
		}
		return JSON.parse(await fs.readFile(summary.path, "utf8"))
	}
}
