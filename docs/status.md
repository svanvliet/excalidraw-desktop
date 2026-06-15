# Excalidraw Desktop — Status

> Living document. Update the table whenever a milestone moves. Keep entries terse — link to PRs/commits for detail.

**Legend:** ⬜ Not started · 🟡 In progress · ✅ Done · ⏸ Blocked · 🗓 Deferred

## Milestones

| ID  | Milestone                                                              | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Project scaffold (Tauri 2 + Vite + React + TS, builds & runs)          | ✅     | `npm run check` green: typecheck + eslint + prettier + vitest + cargo fmt + clippy + cargo test. macOS dev launch pending manual verification.                                                                                                                                                                                                                                                                                                                    |
| M2  | Excalidraw embedded + JSON open/save                                   | ✅     | Editor mounted; open/save commands + dialogs working; 31 tests green (24 JS + 7 Rust).                                                                                                                                                                                                                                                                                                                                                                            |
| M3  | Tabs + recent files + autosave + session restore                       | ✅     | Zustand tabs store, dirty-close prompt, persistent recent files (cap 20), 2s debounced autosave with app-data scratch fallback for untitled tabs, session restore on launch. 77 JS + 10 Rust = 87 tests green.                                                                                                                                                                                                                                                    |
| M4  | PNG export with embedded scene + file associations + double-click open | ✅     | PNG round-trip via `exportToBlob({exportEmbedScene})` + `loadFromBlob`; `.excalidraw` registered via `bundle.fileAssociations`; `tauri-plugin-single-instance` reroutes 2nd double-click; `RunEvent::Opened` (macOS) + CLI argv (Win/Linux) forward via `excalidraw://file-open`; window drag-drop wired. 103 tests green (90 JS + 13 Rust).                                                                                                                      |
| M5  | Native menu bar + keyboard shortcuts                                   | ✅     | Tauri MenuBuilder with File/Edit/View/Window/Help. Custom items route via `excalidraw://menu` to existing App handlers; Undo/Redo/Zoom replay synthetic keydown for Excalidraw's internal handler. Platform-correct `$Mod` → Cmd/Ctrl mapping. 111 tests green (96 JS + 15 Rust).                                                                                                                                                                                 |
| M6  | Settings dialog + opt-in online features (collab / library / AI)       | ✅     | All toggles default false; Zustand `settingsStore` persisted to `settings.json`; `SettingsDialog` modal with 3 toggles + 2 secret fields + Reset-all; wired into `ExcalidrawCanvas` props (`aiEnabled` / `isCollaborating` / `libraryReturnUrl`). Native-keychain secret storage deferred post-v1. 125 tests green (110 JS + 15 Rust).                                                                                                                            |
| M7  | Test coverage (Vitest + cargo test + Playwright/tauri-driver)          | ✅     | Vitest (110 unit + integration tests) and cargo test (15) green via `npm run check`; Playwright web-build smoke (3 tests) green via `npm run e2e`, including a zero-outbound-requests privacy regression test. Tauri-driver native automation deferred post-v1 (M9).                                                                                                                                                                                              |
| M8  | Docs polish + signing/notarization documentation                       | ✅     | New `README.md` with privacy contract, features, quickstart, scripts, layout, signing pointers. `docs/signing-macos.md` (Developer ID + notarytool + stapler runbook). `docs/signing-windows.md` (Azure Trusted Signing + signtool runbook). Implementation of signing/release pipeline deferred to M9.                                                                                                                                                           |
| UX  | UI polish + theme toggle (system / light / dark)                       | ✅     | Token-driven CSS (`src/styles/tokens.css`), lucide-style inline SVG icon set, polished toolbar (icon-first with text for primary actions), tabs, popover, modal with sticky header/footer + scrollable body + animated entry, styled toggle switches. `themeStore` (Zustand + plugin-store) with live `prefers-color-scheme` watching; `ThemeToggle` cycles system → light → dark; resolved theme passed to `<Excalidraw theme>`. 120 JS + 15 Rust + 3 e2e green. |
| M9  | CI release pipeline + auto-update + Linux build                        | 🗓     | Post-v1.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

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

- [x] Two tabs can be open simultaneously with independent state. _(One Excalidraw instance per tab, visibility-toggled; per-tab undo history preserved.)_
- [x] Closing a dirty tab prompts. _(In-app 3-way Save/Don't Save/Cancel modal; ConfirmCloseDialog covered by tests.)_
- [x] Recent files appear in menu, capped at 20, most-recent first. _(Toolbar dropdown for M3; native menu in M5 will share the list.)_
- [x] Killing and relaunching restores the previously open tabs. _(sessionStore persists tabs+activeTabId; missing files are silently skipped.)_
- [x] Autosave fires within 2s of last edit. _(2s debounced; file-backed tabs overwrite path, untitled tabs go to app-data scratch.)_
- [ ] User-side manual verification on `npm run tauri dev` for macOS and Windows still pending.

### M4

- [x] Export a scene as PNG; re-open the PNG; the scene returns identical. _(exportSceneAsPng forces appState.exportEmbedScene = true; loadScenePng round-trips through Excalidraw's loadFromBlob. End-to-end PNG roundtrip with real Excalidraw pending Playwright in M7.)_
- [x] Double-clicking a `.excalidraw` file in Finder/Explorer opens it in the app. _(tauri.conf.json fileAssociations + RunEvent::Opened wiring. Runtime verification requires a packaged build — pending user-side.)_
- [x] Double-clicking a second file with the app already running opens the file in a new tab in the existing window. _(tauri-plugin-single-instance forwards argv to the running instance via `excalidraw://file-open`.)_
- [x] Drag-drop of a `.excalidraw` onto the window opens it. _(webview.onDragDropEvent → openPath.)_
- [ ] Runtime verification on a packaged macOS .app and Windows .exe still pending (M9 builds, or one-off `tauri build` by user).

### M5

- [x] All File/Edit/View/Window/Help items present on macOS and Windows. _(SubmenuBuilder per section; macOS gets the conventional app menu prepended.)_
- [x] Platform-correct accelerators (`Cmd` mac, `Ctrl` win). _(Resolved via the `$Mod` placeholder + a cfg-gated CMD const.)_
- [x] Edit-menu items route to Excalidraw's undo/redo/cut/copy/paste/select-all. _(Cut/Copy/Paste/Select All are predefined; Undo/Redo dispatch synthetic keydown to the document so Excalidraw's history handler runs.)_
- [ ] Runtime verification of menu rendering + accelerator firing pending user-side `npm run tauri dev` on a packaged build.

### M6

- [x] All three toggles default off after fresh install. _(invariant test `every online toggle defaults to false` in settingsStore.test.ts.)_
- [x] Toggle state survives quit + relaunch. _(persisted via `tauri-plugin-store` to `settings.json`; cross-reload test asserts the round-trip.)_
- [ ] With all toggles off, Playwright smoke under network-blocked mode records zero outbound requests. _(M7 — Playwright not wired yet.)_
- [ ] Secrets (OpenAI key, Firebase config) read/write via OS keychain. _(deferred post-v1; for now stored unencrypted in `settings.json` with a loud warning in the dialog.)_

### M7

- [x] `npm test` runs all Vitest suites green. _(110 tests across 16 files.)_
- [x] `cargo test` green. _(15 Rust tests.)_
- [x] `npm run e2e` (Playwright against `vite preview`) green, including the zero-outbound-requests privacy regression. _(3 chromium tests in `e2e/smoke.spec.ts`.)_
- [ ] Native shell automation via `tauri-driver` — deferred to M9 / post-v1.

### M8

- [x] `docs/signing-macos.md` complete with commands a developer can copy/paste.
- [x] `docs/signing-windows.md` complete with commands a developer can copy/paste.
- [x] README quickstart walks a fresh contributor from clone → running dev build in under 5 minutes of reading.

## Changelog of status changes

| Date (UTC) | Milestone | From → To | Note                                                                                                                                   |
| ---------- | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-15 | All       | — → ⬜    | Plan created, work not yet started.                                                                                                    |
| 2026-06-15 | M1        | ⬜ → ✅   | Scaffold + tooling green via `npm run check`. macOS dev launch pending user-side manual verify.                                        |
| 2026-06-15 | M2        | ⬜ → ✅   | Excalidraw embedded; open/save commands + dialogs wired; 31 unit tests green.                                                          |
| 2026-06-15 | M3        | ⬜ → ✅   | Tabs + recent files + autosave + session restore. 87 tests green (77 JS + 10 Rust).                                                    |
| 2026-06-15 | M4        | ⬜ → ✅   | PNG round-trip + .excalidraw file association + double-click + drag-drop. 103 tests green.                                             |
| 2026-06-15 | M5        | ⬜ → ✅   | Native menu bar + Cmd/Ctrl accelerators + dispatched undo/redo/zoom. 111 tests green.                                                  |
| 2026-06-15 | M6        | ⬜ → ✅   | Settings dialog + opt-in online features; defaults off; 125 tests green (110 JS + 15 Rust).                                            |
| 2026-06-15 | M7        | ⬜ → ✅   | Playwright web-build smoke incl. zero-outbound-requests test. tauri-driver E2E deferred to M9.                                         |
| 2026-06-15 | M8        | ⬜ → ✅   | Comprehensive README + macOS / Windows signing runbooks. Signing pipeline impl deferred to M9.                                         |
| 2026-06-15 | UI polish | — → ✅    | Design tokens, SVG icons, polished toolbar/dialog/popover, system/light/dark theme toggle. 135 tests green (120 JS + 15 Rust) + 3 e2e. |
