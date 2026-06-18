/**
 * Shared instruction for the built-in `/remember` slash command.
 *
 * Makes the "lesson → persisted memory/rule" step one action instead of the user
 * spelling out a write_to_file call. Pairs with self-reflection: after `/reflect`
 * surfaces a lesson, `/remember` commits it to the project-memory system (.roo/memory)
 * — or to .roo/rules when it is a standing behavioral rule.
 */
export const REMEMBER_PROMPT = `Persist a durable lesson about this project so future tasks benefit.

The text after the command (if any) is what to remember. If it is empty, infer the single most useful, non-obvious lesson from the current conversation (e.g. a gotcha just discovered, a correction the user made, a convention you had to learn).

Decide where it belongs:
- A FACT about the project (architecture, gotcha, workflow, "why it's done this way") → write it to \`.roo/memory/<kebab-slug>.md\`, one fact per file.
- A standing BEHAVIORAL RULE for how you should act in this project ("always run X before Y", "never touch Z") → append it to the project rules at \`.roo/rules/\` instead.

Before writing:
- Check whether an existing memory/rule already covers it; if so, UPDATE that file rather than creating a duplicate.
- Keep it concise (a few sentences) and self-contained — it will be read cold, without this conversation's context.
- Do not store secrets, credentials, or large code dumps.

Use the \`write_to_file\` tool to create or update the file, then briefly confirm to the user what you saved and where. This is a quick bookkeeping action — do not start unrelated work.`
