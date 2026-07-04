import * as fs from "fs/promises"
import * as path from "path"

import type { WorkflowSummary } from "@roo-code/types"
import { safeWriteJson } from "../../utils/safeWriteJson"

import { getGlobalRooDirectory } from "../../services/roo-config"

export type { WorkflowSummary }

/** Workflow ids follow the same slug rule as skills/mode slugs. */
const WORKFLOW_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Fields that belong to the *architecture* layer (determine flow behavior).
 * These stay in the architecture file and are NOT overwritten by the config
 * file during merge. Everything else in node.data is considered *content* and
 * can come from the config file.
 */
const ARCHITECTURE_NODE_DATA_FIELDS = new Set(["exec", "expression", "customData"])

/**
 * Determine if a node's data looks like a "legacy" single-file format (i.e. it
 * already has content fields like `prompt`/`toolName` in the architecture file).
 * If so, we skip merging the config file — the architecture file is complete.
 */
function isLegacyNode(data: Record<string, unknown>): boolean {
	return "prompt" in data || "toolName" in data || "skillName" in data || "subtaskPrompt" in data
}

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

	/** Read + parse the full workflow graph JSON for `id`, merging the optional
	 * config file (`<id>.config.json`) if it exists. See
	 * docs/workflow-dual-file-design.md for the merge rules. */
	async load(id: string): Promise<unknown> {
		const summary = this.workflows.get(id)
		if (!summary) {
			throw new Error(`Workflow not found: "${id}"`)
		}

		const graph = JSON.parse(await fs.readFile(summary.path, "utf8")) as Record<string, unknown>
		const configPath = summary.path.replace(/\.json$/, ".config.json")

		// Try to load the config file; if absent, the architecture file is
		// either legacy (complete) or simply has no separate config.
		let config: Record<string, Record<string, unknown>> = {}
		try {
			config = JSON.parse(await fs.readFile(configPath, "utf8"))
		} catch {
			return graph // no config file — return as-is (legacy or config-less)
		}

		// Merge config into each node's data
		const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
		for (const node of nodes) {
			const n = node as Record<string, unknown>
			const nodeId = typeof n.id === "string" ? n.id : ""
			const data = (n.data ?? {}) as Record<string, unknown>

			// Legacy check: if the architecture file already has content fields,
			// skip merging (backward compatibility with single-file workflows).
			if (isLegacyNode(data)) continue

			const nodeConfig = config[nodeId]
			if (nodeConfig && typeof nodeConfig === "object") {
				// Architecture fields take precedence (exec, expression, customData)
				const merged: Record<string, unknown> = { ...nodeConfig }
				for (const archKey of ARCHITECTURE_NODE_DATA_FIELDS) {
					if (archKey in data) {
						merged[archKey] = data[archKey]
					}
				}
				n.data = merged
			}
		}

		return graph
	}

	/**
	 * Save a workflow as two files: architecture (`<id>.json`) + config
	 * (`<id>.config.json`). Splits node.data into architecture fields (exec,
	 * expression, customData) and content fields (everything else).
	 */
	async save(id: string, dir: string, graph: Record<string, unknown>): Promise<void> {
		const archPath = path.join(dir, `${id}.json`)
		const configPath = path.join(dir, `${id}.config.json`)

		const config: Record<string, Record<string, unknown>> = {}
		const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
		const archNodes: unknown[] = []

		for (const node of nodes) {
			const n = node as Record<string, unknown>
			const nodeId = typeof n.id === "string" ? n.id : ""
			const data = (n.data ?? {}) as Record<string, unknown>

			// Split data into architecture fields and content fields
			const archData: Record<string, unknown> = {}
			const contentData: Record<string, unknown> = {}

			for (const [key, value] of Object.entries(data)) {
				if (ARCHITECTURE_NODE_DATA_FIELDS.has(key)) {
					archData[key] = value
				} else {
					contentData[key] = value
				}
			}

			// Architecture node: id, type, position, data (architecture fields only)
			archNodes.push({
				id: n.id,
				type: n.type,
				position: n.position,
				data: archData,
			})

			// Config: only store if there are content fields
			if (Object.keys(contentData).length > 0) {
				config[nodeId] = contentData
			}
		}

		const archGraph = { ...graph, nodes: archNodes }

		await safeWriteJson(archPath, archGraph)
		await safeWriteJson(configPath, config)
	}
}
