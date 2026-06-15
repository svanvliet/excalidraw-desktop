# CLAUDE.md

> Project-level context for Claude Code (and any other AI coding assistant) working in this repo.
> **Read this first.** Then read `docs/requirements.md`, `docs/plan.md`, and `docs/status.md`.

---

## 1. What this project is

A native desktop wrapper around the official **Excalidraw** editor for macOS and Windows. Built on **Tauri 2** with a **Vite + React + TypeScript** frontend that embeds the official `@excalidraw/excalidraw` React component. The app runs **fully offline**; the local filesystem is the source of truth. Online features (collab / library browser / AI) are **opt-in** and off by default.

See `docs/requirements.md` for the full spec and `docs/plan.md` for the architecture and milestones.

## 2. Source of truth (read these before changing things)

| File                    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `docs/requirements.md`  | What the app must do. Treat as a contract.                    |
| `docs/plan.md`          | How we're building it. Architecture, stack, milestones, decisions log. |
| `docs/status.md`        | Where we are. Update when a milestone moves.                  |
| `CLAUDE.md` (this file) | How to work in this repo. Conventions, commands, skills.      |

**If you change scope, behavior, or stack:** update `docs/requirements.md` and/or `docs/plan.md` in the same change. **If you complete a milestone or acceptance check:** update `docs/status.md`.

## 3. Core conventions

### Privacy & networking
- The app's promise to users is that **no diagram data leaves the device unless they opt in**. Any code that adds a network call MUST:
  1. Be gated behind an explicit setting toggle (default off).
  2. Be covered by a Playwright smoke test under a network-blocked profile that verifies the toggle works.
  3. Be reflected in the runtime CSP (see `docs/plan.md` § "CSP").

### Tauri capabilities
- Keep `src-tauri/capabilities/default.json` **minimal**. Adding a new capability needs a justification comment in the diff and a line in `docs/plan.md` § "Tauri capabilities".
- Filesystem access is **dialog-scoped** — never grant blanket `$HOME` read.

### Secrets
- Never write API keys or Firebase config to JSON on disk. Use `tauri-plugin-keyring` (Keychain on macOS, Credential Manager on Windows).

### Frontend
- React function components only.
- Zustand for app-level state. No Redux.
- No inline `style={{...}}` for non-trivial styles — use CSS modules or styled-components consistently with what's already in the file you're editing.
- All `invoke()` calls go through typed wrappers in `src/ipc/commands.ts` — never call `invoke('foo')` directly from a component.

### Rust
- Every public command in `src-tauri/src/commands/` returns `Result<T, AppError>` where `AppError` is the project's error enum.
- `cargo clippy -- -D warnings` must pass.

### Tests
- New behavior ships with a test. New Tauri command → cargo test. New React component with logic → Vitest. New user-visible flow → Playwright smoke if feasible.
- Tests live next to source when possible (`foo.ts` + `foo.test.ts`), or in `e2e/` for Playwright specs.

### Commits
- **Commit early and commit often.** Make small, focused commits at every meaningful checkpoint — a passing scaffold, a green test, a new module wired in. Do not batch a day's work into one large commit.
- Conventional Commits style: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
- One logical change per commit. If a single change touches multiple concerns, split it.
- After every commit, the repo MUST be in a working state — lint, typecheck, and tests should pass (or the commit message explicitly flags a known-broken WIP that the next commit will fix).

## 4. Commands cheat-sheet

> All commands run from the repo root unless noted.

| Goal                          | Command                                |
| ----------------------------- | -------------------------------------- |
| Install deps                  | `npm install`                          |
| Run app in dev                | `npm run tauri dev`                    |
| Frontend-only dev (no Rust)   | `npm run dev`                          |
| Build distributable           | `npm run tauri build`                  |
| Frontend lint                 | `npm run lint`                         |
| Frontend type-check           | `npm run typecheck`                    |
| Frontend unit tests           | `npm test` (or `npm run test:watch`)   |
| Rust format check             | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` |
| Rust lint                     | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` |
| Rust tests                    | `cargo test --manifest-path src-tauri/Cargo.toml` |
| End-to-end (Playwright)       | `npm run e2e`                          |
| All checks (pre-PR)           | `npm run check`                        |

If a command above is missing in `package.json`, add it — don't invent ad-hoc invocations.

## 5. Architecture in 60 seconds

```
Webview (React + @excalidraw/excalidraw)
        │  invoke() ↔ events
        ▼
Rust core (src-tauri/)
  ├── commands/  ← file I/O, recent, settings
  ├── menu.rs    ← native menu bar
  ├── associations.rs ← double-click / drag-drop routing
  └── plugins:   store, dialog, fs, deep-link,
                 single-instance, keyring, opener
```

Full diagram in `docs/plan.md` § "Architecture overview".

## 6. File formats we handle

- `.excalidraw` — JSON, native. **Authoritative format.**
- `.png` — PNG with embedded Excalidraw scene metadata. Convenience for sharing; still re-openable.

Detection logic lives in `src/lib/fileFormat.ts` and is unit-tested.

## 7. Skills & Agents

Custom helpers live under `.claude/`. Track every one here so contributors can find them.

### Slash commands (`.claude/commands/`)

| Command                       | What it does                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `/new-tauri-command <name>`   | Scaffolds a Rust command (`src-tauri/src/commands/`), registers it in `lib.rs`, generates the typed TS wrapper in `src/ipc/commands.ts`, and creates Vitest + cargo test stubs. |
| `/bump-excalidraw`            | Updates `@excalidraw/excalidraw`, reads its changelog, runs `npm test` and the Playwright smoke suite, and reports any breaking changes the bump introduces. |
| `/release-checklist`          | Walks pre-release validation: bump version, regenerate changelog, run lint + all tests on both platforms, verify status.md milestones, tag. |

### Subagents (`.claude/agents/`)

| Agent                  | Use when…                                                                |
| ---------------------- | ------------------------------------------------------------------------ |
| `tauri-architect`      | Designing a new Tauri command, IPC flow, or capability/CSP change. Calls out impact on `default.json` and on networking promises. |
| `excalidraw-integrator`| Mapping a desired UX onto the `@excalidraw/excalidraw` API surface (props, refs, imperative API, theme, fonts, libraries). |

> When you add a skill or agent, **add a row to the table above** in the same change.

## 8. Things to never do

- Add a network call that isn't gated behind a settings toggle.
- Add a Tauri capability without updating `docs/plan.md`.
- Write secrets to disk in plaintext.
- Ship a milestone without checking the boxes in `docs/status.md` § "Acceptance checks".
- Fork or vendor `@excalidraw/excalidraw` — we depend on it via npm to inherit upstream fixes.
- Add telemetry, analytics, or crash reporters that phone home.

## 9. Useful reading

- Tauri 2 docs: https://v2.tauri.app/
- Excalidraw component API: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation
- Tauri file associations: https://v2.tauri.app/learn/file-associations/
- WebDriver / tauri-driver: https://v2.tauri.app/develop/tests/webdriver/
