/**
 * Shared self-reflection (self-evaluation) instruction.
 *
 * Used in two places:
 * - The built-in `/reflect` slash command (manual, always available).
 * - The automatic post-completion pass when the `enableSelfReflection` setting is on
 *   (see `AttemptCompletionTool`).
 *
 * The prompt deliberately frames the model as an independent, skeptical reviewer of its
 * OWN just-completed work — a bare score is useless, so it asks for a concrete, actionable
 * findings list and a fix-then-recomplete loop, and ties durable lessons back into the
 * project memory system (.roo/memory).
 */
export const SELF_REFLECTION_PROMPT = `Critically self-evaluate the work you just completed on this task, acting as an independent, skeptical reviewer. Assume the work contains mistakes until you have verified otherwise — do NOT simply restate why your approach was correct.

Review against these dimensions and report concrete findings (not a score):
1. Correctness vs. intent — does the result actually satisfy what was asked, including implied requirements? Did you solve the right problem?
2. Verification — were the relevant tests/build/type-checks actually run and did they pass? If not, that is a finding.
3. Regressions — could these changes break existing behavior or callers?
4. Edge cases — unhandled inputs, error paths, boundary conditions.
5. Quality — duplicated logic that reuses existing helpers, security issues, leftover debug/dead code.

Then:
- If you find one or more REAL issues, list them, FIX them, and continue working. Do not re-run completion until they are addressed.
- If after honest review there are genuinely no real issues, say so in one or two sentences and complete.
- If you uncovered a durable, non-obvious lesson about this project, persist it to \`.roo/memory/\` (one fact per file) so future tasks benefit.

Be specific and honest. Surfacing a real problem now is far more valuable than confirming the work looks fine.`
