# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

This is a **customized fork of Roo Code** (the upstream open-source VS Code AI coding agent). It tracks upstream selectively rather than wholesale. Notable divergences from upstream (see `progress.txt` for the reapplication log):

- **No AI-SDK** — this codebase predates upstream's migration to Vercel's `ai` SDK (`@ai-sdk/*`). Provider handlers (e.g. `gemini.ts`, `vertex.ts`) are kept in their pre-AI-SDK form. Do **not** introduce `ai` / `@ai-sdk/*` dependencies; PRs that are "AI-SDK-entangled" are intentionally excluded.
- **Browser use removed** — the built-in browser tool was deleted entirely.
- **Reduced provider set** — several low-usage API providers were removed.
- **Skills infrastructure added** — a skill/slash-command system (the built-in _generated_ skills mechanism was removed; skills are now data-driven).

When porting upstream PRs, verify they don't reintroduce AI-SDK or browser-use code.

## Monorepo layout

pnpm + Turbo monorepo (`pnpm-workspace.yaml`). Node `20.19.2`, pnpm `10.8.1`. The two largest workspaces are aliased oddly for historical reasons:

- `src/` — the VS Code extension host (package name `qcode`; the marketplace/namespace identity is `QCode.qcode`). Despite living at the repo root, it is a workspace member; comments note it "should be apps/vscode".
- `webview-ui/` — the React webview UI (Vite). "Should be apps/vscode-webview".
- `packages/types` — `@roo-code/types`, shared Zod schemas and types. Many packages depend on its build; `turbo` builds it before tests.
- `packages/core` — shared agent core (CLI/headless surface: task-history, worktree, custom-tools, message-utils).
- `packages/ipc`, `packages/vscode-shim`, `packages/build`, `packages/config-eslint`, `packages/config-typescript`.
- `apps/cli` — `@roo-code/cli`, runs the agent from the command line.
- `apps/vscode-e2e`, `apps/vscode-nightly`, `apps/docs`.

## Commands

Run from repo root unless noted. Turbo fans tasks out across workspaces:

```bash
pnpm install          # bootstraps via scripts/bootstrap.mjs (do not bypass)
pnpm build            # turbo build
pnpm bundle           # esbuild bundle of the extension
pnpm vsix             # package the .vsix into bin/
pnpm lint             # turbo lint (eslint, --max-warnings=0)
pnpm check-types      # turbo tsc --noEmit
pnpm test             # turbo test (builds @roo-code/types first)
pnpm format           # prettier
```

### Running tests (important)

Tests use **Vitest** and **must run from inside the workspace that owns the `package.json`** — running from the repo root gives `vitest: command not found`. The path passed must be relative to that workspace (do not prefix with `src/`):

```bash
# Backend (extension host) tests:
cd src && npx vitest run path/to/test-file        # NOT src/path/...

# Webview UI tests:
cd webview-ui && npx vitest run src/path/to/test-file
```

`vi`, `describe`, `test`, `it`, etc. are globals (configured in tsconfig) — do not import them from `vitest`.

## Architecture

The extension is the host process; the webview is a separate React app. They communicate over a message bus.

- **`src/extension.ts` / `src/activate`** — VS Code activation entry point.
- **`src/api/`** — the LLM provider layer. `index.ts` is the handler factory; `providers/*` are per-provider handlers (all extend `base-provider.ts` / `base-openai-compatible-provider.ts`); `transform/` normalizes message formats.
- **`src/core/`** — the agent engine:
    - `task/` — the central `Task` loop (uses Anthropic SDK types directly).
    - `tools/` — tool implementations (read/write/diff/command/etc).
    - `prompts/` — system prompt construction.
    - `assistant-message/` — parsing model output into tool calls.
    - `context/`, `context-management/`, `context-tracking/`, `condense/` — context window management and condensing.
    - `config/` — settings via `ContextProxy` (the source of truth).
    - `checkpoints/`, `task-persistence/`, `message-queue/`, `mentions/`, `diff/`, `ignore/`.
- **`webview-ui/src/`** — React UI. `context/ExtensionStateContext` mirrors host state; `components/`, `hooks/`, `i18n/`.

### Modes & skills

`.roomodes` defines custom modes (Translate, Issue Fixer, etc.) declaratively. `.roo/rules*` directories hold per-mode rule markdown (general rules live in `.roo/rules/rules.md`). The skill/slash-command system lives under `.roo/skills` and `.roo/commands`.

## Conventions

- **SettingsView**: inputs must bind to the local `cachedState` buffer, **not** the live `useExtensionState()`. `cachedState` isolates user edits from the `ContextProxy` source-of-truth until "Save" is clicked; wiring directly to live state causes race conditions. (See `AGENTS.md`.)
- **Styling**: use Tailwind classes, not inline style objects, for new markup. New VSCode CSS variables must be added to `webview-ui/src/index.css` before being used in Tailwind classes (e.g. `text-vscode-descriptionForeground`).
- **Lint**: never disable a lint rule without explicit user approval. `--max-warnings=0` is enforced.
- **Tests**: ensure new code has test coverage and all tests pass before completing.
- **i18n**: user-facing strings are localized; `locales/` and `src/package.nls.*.json` carry translations.

## Releases

Uses Changesets (`.changeset/`). `pnpm changeset:version` syncs `CHANGELOG.md` into `src/` and bumps versions.

## Git tooling

- Git Commit Message Info,wirte like this:AI(AI模型简称)-提交内容分类：具体内容概括，多内容时可以一句概述然后具体事项换行，1，2，3，4，...这样列出。
- Can Commit but never push.
- 按功能颗粒度细一点提交，以后有问题直接revert整个Commit比较方便。
- 每次提交只包含这次功能修改相关内容，不是你改的不要提交。
- AI模型简称：DS4(deepseek v4)、GLM(glm)、MM(MiniMax)、DB(doubao)、MM(MiniMax)
