import type { SystemPromptSettings } from "../types"

/**
 * Instruction section for the project-memory system ("memory-type evolution").
 *
 * Persisted memory is read from `.roo/memory/*.md` and injected back into the
 * system prompt on later tasks (see `loadMemoryFiles` in `custom-instructions.ts`).
 * This section tells the model WHEN and HOW to write a memory so the read side has
 * something useful to inject. It is only emitted when project memory is enabled.
 */
export function getMemoryInstructionsSection(settings?: SystemPromptSettings): string {
	if (settings?.useProjectMemory === false) {
		return ""
	}

	return `====

PROJECT MEMORY

You have a persistent, per-project memory stored as Markdown files under \`.roo/memory/\` in the current workspace. Any files already there have been injected into your context above under "Project memory from .roo directories". Use that knowledge; do not re-derive what is already recorded.

When you learn something durable and non-obvious about THIS project that would save effort on a future task, record it by writing a new file (or updating an existing one) under \`.roo/memory/\` using the \`write_to_file\` tool. One fact per file, named with a short kebab-case slug (e.g. \`.roo/memory/auth-flow.md\`).

Write a memory when you discover:
- A non-obvious architectural decision, convention, or constraint not evident from a quick read of the code.
- A gotcha, workaround, or "why it's done this way" that cost you effort to figure out.
- Stable facts about build/test/deploy workflow specific to this project.
- User preferences or recurring guidance that should persist across tasks.

Do NOT write a memory for:
- Things already obvious from the code, README, or existing rules.
- Transient details that only matter to the current task.
- Secrets, credentials, or large code dumps.

Keep each memory concise (a few sentences). Before adding a new file, check whether an existing memory already covers the fact and update it instead of duplicating. Only write memory when it is genuinely useful — do not write one on every task, as this is wasteful.`
}
