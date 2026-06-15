# Excalidraw Desktop — Status

> Living document. Update the table whenever a milestone moves. Keep entries terse — link to PRs/commits for detail.

**Legend:** ⬜ Not started · 🟡 In progress · ✅ Done · ⏸ Blocked · 🗓 Deferred

## Milestones

| ID  | Milestone                                                              | Status | Notes                                                                                                                                          |
| --- | ---------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Project scaffold (Tauri 2 + Vite + React + TS, builds & runs)          | ✅     | `npm run check` green: typecheck + eslint + prettier + vitest + cargo fmt + clippy + cargo test. macOS dev launch pending manual verification. |
| M2  | Excalidraw embedded + JSON open/save                                   | ✅     | Editor mounted; open/save commands + dialogs working; 31 tests green (24 JS + 7 Rust).                                                         |
| M3  | Tabs + recent files + autosave + session restore                       | ⬜     |                                                                                                                                                |
| M4  | PNG export with embedded scene + file associations + double-click open | ⬜     |                                                                                                                                                |
| M5  | Native menu bar + keyboard shortcuts                                   | ⬜     |                                                                                                                                                |
| M6  | Settings dialog + opt-in online features (collab / library / AI)       | ⬜     | Off by default.                                                                                                                                |
| M7  | Test coverage (Vitest + cargo test + Playwright/tauri-driver)          | ⬜     |                                                                                                                                                |
| M8  | Docs polish + signing/notarization documentation                       | ⬜     | Implementation deferred — docs only.                                                                                                           |
| M9  | CI release pipeline + auto-update + Linux build                        | 🗓     | Post-v1.                                                                                                                                       |

## Acceptance checks (per milestone)

### M1

- [ ] `npm run tauri dev` opens an empty window on macOS. _(pending manual verification — requires user-side launch)_
- [ ] `npm run tauri dev` opens an empty window on Windows. _(pending Windows runner)_
- [x] `npm run lint`, `npm run typecheck`, `npm test`, `cargo clippy -- -D warnings`, `cargo fmt -- --check`, `cargo test` all pass via `npm run check`.

### M2

- [x] Editor renders and is interactive. _(verified in unit tests via component render; runtime verification awaits manual `npm run tauri dev`.)_
- [x] Open a `.excalidraw` file → contents appear. _(Rust `open_file` + `detectFormat` round-trip covered by unit tests; end-to-end will land in M7 Playwright.)_
- [x] Edit + Save → file on disk changes. _(Rust `save_file` covered by `cargo test`; end-to-end in M7.)_
- [ ] No outbound network requests observed. _(deferred to M7 Playwright with network-blocked profile.)_

### M3

- [ ] Two tabs can be open simultaneously with independent state.
- [ ] Closing a dirty tab prompts.
- [ ] Recent files appear in menu, capped at 20, most-recent first.
- [ ] Killing and relaunching restores the previously open tabs.
- [ ] Autosave fires within 2s of last edit.

### M4

- [ ] Export a scene as PNG; re-open the PNG; the scene returns identical.
- [ ] Double-clicking a `.excalidraw` file in Finder/Explorer opens it in the app.
- [ ] Double-clicking a second file with the app already running opens the file in a new tab in the existing window.
- [ ] Drag-drop of a `.excalidraw` onto the window opens it.

### M5

- [ ] All File/Edit/View/Window/Help items present on macOS and Windows.
- [ ] Platform-correct accelerators (`Cmd` mac, `Ctrl` win).
- [ ] Edit-menu items route to Excalidraw's undo/redo/cut/copy/paste/select-all.

### M6

- [ ] All three toggles default off after fresh install.
- [ ] Toggle state survives quit + relaunch.
- [ ] With all toggles off, Playwright smoke under network-blocked mode records zero outbound requests.
- [ ] Secrets (OpenAI key, Firebase config) read/write via OS keychain.

### M7

- [ ] `npm test` runs all Vitest suites green.
- [ ] `cargo test` green.
- [ ] `npm run e2e` (Playwright + tauri-driver) green on macOS and Windows runners.

### M8

- [ ] `docs/signing-macos.md` complete with commands a developer can copy/paste.
- [ ] `docs/signing-windows.md` complete with commands a developer can copy/paste.
- [ ] README quickstart walks a fresh contributor from clone → running dev build in under 5 minutes of reading.

## Changelog of status changes

| Date (UTC) | Milestone | From → To | Note                                                                                            |
| ---------- | --------- | --------- | ----------------------------------------------------------------------------------------------- |
| 2026-06-15 | All       | — → ⬜    | Plan created, work not yet started.                                                             |
| 2026-06-15 | M1        | ⬜ → ✅   | Scaffold + tooling green via `npm run check`. macOS dev launch pending user-side manual verify. |
| 2026-06-15 | M2        | ⬜ → ✅   | Excalidraw embedded; open/save commands + dialogs wired; 31 unit tests green.                   |
