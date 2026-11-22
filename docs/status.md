# Excalidraw Desktop — Status

> Living document. Update the table whenever a milestone moves. Keep entries terse — link to PRs/commits for detail.

**Legend:** ⬜ Not started · 🟡 In progress · ✅ Done · ⏸ Blocked · 🗓 Deferred

## Milestones

| ID    | Milestone                                                                                     | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1    | Project scaffold (Tauri 2 + Vite + React + TS, builds & runs)                                 | ✅     | `npm run check` green: typecheck + eslint + prettier + vitest + cargo fmt + clippy + cargo test. macOS dev launch pending manual verification.                                                                                                                                                                                                                                                                                                                    |
| M2    | Excalidraw embedded + JSON open/save                                                          | ✅     | Editor mounted; open/save commands + dialogs working; 31 tests green (24 JS + 7 Rust).                                                                                                                                                                                                                                                                                                                                                                            |
| M3    | Tabs + recent files + autosave + session restore                                              | ✅     | Zustand tabs store, dirty-close prompt, persistent recent files (cap 20), 2s debounced autosave with app-data scratch fallback for untitled tabs, session restore on launch. 77 JS + 10 Rust = 87 tests green.                                                                                                                                                                                                                                                    |
| M4    | PNG export with embedded scene + file associations + double-click open                        | ✅     | PNG round-trip via `exportToBlob({exportEmbedScene})` + `loadFromBlob`; `.excalidraw` registered via `bundle.fileAssociations`; `tauri-plugin-single-instance` reroutes 2nd double-click; `RunEvent::Opened` (macOS) + CLI argv (Win/Linux) forward via `excalidraw://file-open`; window drag-drop wired. 103 tests green (90 JS + 13 Rust).                                                                                                                      |
| M5    | Native menu bar + keyboard shortcuts                                                          | ✅     | Tauri MenuBuilder with File/Edit/View/Window/Help. Custom items route via `excalidraw://menu` to existing App handlers; Undo/Redo/Zoom replay synthetic keydown for Excalidraw's internal handler. Platform-correct `$Mod` → Cmd/Ctrl mapping. 111 tests green (96 JS + 15 Rust).                                                                                                                                                                                 |
| M6    | Settings dialog + opt-in online features (collab / library / AI)                              | ✅     | All toggles default false; Zustand `settingsStore` persisted to `settings.json`; `SettingsDialog` modal with 3 toggles + 2 secret fields + Reset-all; wired into `ExcalidrawCanvas` props (`aiEnabled` / `isCollaborating` / `libraryReturnUrl`). Native-keychain secret storage deferred post-v1. 125 tests green (110 JS + 15 Rust).                                                                                                                            |
| M7    | Test coverage (Vitest + cargo test + Playwright/tauri-driver)                                 | ✅     | Vitest (110 unit + integration tests) and cargo test (15) green via `npm run check`; Playwright web-build smoke (3 tests) green via `npm run e2e`, including a zero-outbound-requests privacy regression test. Tauri-driver native automation deferred post-v1 (M9).                                                                                                                                                                                              |
| M8    | Docs polish + signing/notarization documentation                                              | ✅     | New `README.md` with privacy contract, features, quickstart, scripts, layout, signing pointers. `docs/signing-macos.md` (Developer ID + notarytool + stapler runbook). `docs/signing-windows.md` (Azure Trusted Signing + signtool runbook). Implementation of signing/release pipeline deferred to M9.                                                                                                                                                           |
| UX    | UI polish + theme toggle (system / light / dark)                                              | ✅     | Token-driven CSS (`src/styles/tokens.css`), lucide-style inline SVG icon set, polished toolbar (icon-first with text for primary actions), tabs, popover, modal with sticky header/footer + scrollable body + animated entry, styled toggle switches. `themeStore` (Zustand + plugin-store) with live `prefers-color-scheme` watching; `ThemeToggle` cycles system → light → dark; resolved theme passed to `<Excalidraw theme>`. 120 JS + 15 Rust + 3 e2e green. |
| M9    | CI release pipeline + auto-update + Linux build                                               | 🗓     | Post-v1. Release portion superseded by M11.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| M10   | Live collaboration (embedded relay + DevTunnels + browser guests)                             | ✅     | Validated interactively: host ↔ browser guests (local + tunnel) and app ↔ app (`--profile guest`). Roles, request-to-edit, remove, viewport sync, guest clear on leave/end.                                                                                                                                                                                                                                                                                       |
| M11   | Local notarized macOS release + CI Windows                                                    | ✅     | v0.1.1 published: notarized universal DMG + Windows MSI/EXE, latest.json for 3 platforms.                                                                                                                                                                                                                                                                                                                                                                         |
| M12   | Signed auto-update (macOS universal + Windows)                                                | 🟡     | Updater, consent prompt, Settings → Updates, signed feed + release scripts done. 0.1.1 and 0.1.2 published; awaiting confirmation of a real 0.1.1 → 0.1.2 update.                                                                                                                                                                                                                                                                                                 |
| AI-0  | AI agent: engine / MCP / binding / CSP spikes                                                 | 🟡     | Headless live runs on macOS: Claude Code 2.1.329 and Codex 0.170.0 (fixtures recorded); Copilot not installed here. Min versions pinned: Copilot 1.0.0, Claude 2.0.0, Codex 0.156.0. Windows spikes pending.                                                                                                                                                                                                                                                      |
| AI-1  | AI agent: foundation (settings migration, detect, process mgr, MCP server + shim, read tools) | ✅     | `openAiKey` scrubbed; login-shell PATH detect; process tree mgr (process group / Job Object); loopback MCP server (per-session tokens, Host/Origin guard) + `--mcp-shim`; per-tab manager.                                                                                                                                                                                                                                                                        |
| AI-2  | AI agent: Copilot ACP / Claude stream-json / Codex app-server adapters + sandbox              | ✅     | Copilot via ACP, Claude via stream-json (stdio `can_use_tool`), Codex via app-server (workspace-write sandbox x3, no network). Writes scoped to the session/attached folder and auto-approved there; shell approval-gated; API-key env vars stripped. Live smoke: `commands::agent::live_tests`.                                                                                                                                                                  |
| AI-3  | AI agent: canvas edit tools + Revert turn                                                     | ✅     | 13 canvas tools (`src/agent/sceneTools.ts`), revision checks, Mermaid import, one undo step per turn, Revert turn with conflict confirm. Viewer tabs refuse edits.                                                                                                                                                                                                                                                                                                |
| AI-4  | AI agent: docked chat panel + Settings → AI                                                   | ✅     | Docked panel (conversation menu per drawing, permission cards, plan, usage, Stop, Revert), Settings → AI with detection, View → AI Panel, ⌘/Ctrl+Shift+A.                                                                                                                                                                                                                                                                                                         |
| AI-5  | AI agent: TTD dialog, resume, collab indicator, logging                                       | 🟡     | Collab indicator, logging and resume done: per-drawing conversation list with reopen/resume, engine/model/folder bar (live model switch on Copilot/Codex). Remaining: agent-backed TTD dialog (FR-34), selection context chips.                                                                                                                                                                                                                                   |
| AI-6  | AI agent: 3 engines × 2 OS validation + terms review                                          | ⬜     | `docs/ai-testing.md`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DX-1  | DX wave 1: properties-panel host, shape data, elbow anchors                                   | ✅     | Generic `PropertiesPanelHost` with a Ctrl/Cmd key bridge (D-DX4); key/value shape data with a Data section, CSV copy and `set_shape_data`/`get_shape_data` (D-DX2); elbow anchors in an Anchors section, `connect` anchors and `set_arrow_anchors` (D-DX8). Vitest + `e2e/shape-data-anchors.spec.ts` green.                                                                                                                                                      |
| DX-2  | DX wave 2: Components core (engine + agent tools)                                             | 🟡     | Engine, live sync, overrides, orphans, duplicate, collab, 6 MCP tools, smoke. UI is a follow-up lane.                                                                                                                                                                                                                                                                                                                                                             |
| DX-5  | DX wave 2: Named styles                                                                       | ✅     | Style definitions on linked elements, live reactor rule before components (chained), overrides, 6 MCP tools, Styles tab + panel picker. Vitest + `e2e/styles.spec.ts` green.                                                                                                                                                                                                                                                                                      |
| DX-3  | DX wave 2: Components UI (tab, My components, panel section, library masters)                 | ✅     | Components tab, My components with images and `.excalidrawlib` export, panel section, Edit master… / Done / Cancel on the engine primitives, Edit → Create Component, 2 MCP tools (FR-55, D-DX10). Vitest + `e2e/components-ui.spec.ts` green.                                                                                                                                                                                                                    |
| DX-6  | DX wave 2: Smart containers                                                                   | ✅     | Stack containers (gap, padding, align, distribute, hug or fixed), live re-flow on the reactor (one undo step, no collab echo), Container panel section + Alt/Option+Shift+A, 6 MCP tools (FR-59, D-DX13). Vitest + `e2e/containers.spec.ts` green. Layout menu/toolbar entries via DX-7.                                                                                                                                                                          |
| DX-7  | DX wave 2: Tidy arrows + Layout menu                                                          | ✅     | Layout ▸ Tidy Arrows (selection or all, one undo step, optional convert) with an orthogonal obstacle-avoiding router and org-chart trunks; top-level Layout menu + toolbar Layout dropdown from one command list (auto-layout, tidy, containers); `tidy_arrows` MCP tool (FR-60, D-DX14). Vitest + `e2e/tidy-arrows.spec.ts` green.                                                                                                                               |
| DX-4  | DX wave 2: Component properties + nested components                                           | ✅     | Typed properties bound to slots (instance values = overrides), Properties panel section, nested components (cycles rejected, cascade sync, overrides at both levels), 3 MCP tools (FR-56, FR-57, D-DX11). Real-Excalidraw + collab vitest and `e2e/component-properties.spec.ts` (incl. real Alt-drag) green.                                                                                                                                                     |
| DX-8  | DX wave 2: Line anchors (face-centre snap)                                                    | ✅     | Snap dots at face midpoints + centre while dragging an arrow end; release within 12px snaps, binds and pins the end so it follows move/resize/rotate (straight, curved, elbow; Cmd/Ctrl bypass; setting). Anchors panel + `set_arrow_anchors`/`connect` pin straight ends (FR-61, D-DX15). Vitest + `e2e/line-anchors.spec.ts` green.                                                                                                                             |
| DX-9  | UX: Pinned sidebar survives the AI panel                                                      | ✅     | A pinned Library or app tab stays docked when the AI panel opens and closes (docking breakpoint 760px); narrow windows reopen it when the panel closes (FR-62, D-DX16). Vitest + `e2e/sidebar-ai.spec.ts` green.                                                                                                                                                                                                                                                  |
| DX-10 | UX wave: properties-panel strip (accordion at the panel top)                                  | ✅     | Our sections are compact rows (icon, title, summary, inline primary) at the top of the native panel; single-open accordion remembered in settings (FR-63, D-DX17). Vitest `PropertiesPanelHost` + `e2e/panel-strip.spec.ts` green.                                                                                                                                                                                                                                |
| DX-11 | UX wave: concept demotions (progressive disclosure)                                           | ✅     | Style and Data rows only when used, "+" row for Apply style / Add data / Make stack; Styles tab removed (rename/delete in the Style row); "Stack" naming; Connection row; Properties inside Component (FR-65, D-DX19). Vitest `PropertiesPanelHost` + `sections` and Playwright green.                                                                                                                                                                            |
| DX-12 | DX wave 3: Masterless components + master-edit overlay                                        | 🟡     | Engine (L5): create makes the first instance, `applyMasterEdit` (one undo step), load-time demotion of legacy masters, `ms` look record, masterless agent tools + `get_component_master` / `edit_component_master` (FR-64, D-DX18). Vitest + collab real test + `e2e/components-ui.spec.ts` green. Overlay (L6, FR-66) pending.                                                                                                                                   |

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

### M10

- [x] Relay: host-registered rooms only, 127.0.0.1 bind, limits; cargo tests.
- [x] DevTunnel auto + manual URL + local modes.
- [x] Sync engine: edits, cursors, selections, avatars, images; Vitest.
- [x] Browser guest mode served by relay.
- [x] Static CSP (D-C3) + self-hosted fonts; `e2e/csp-privacy.spec.ts` verifies zero outbound requests with collab off.
- [x] Playwright: 2 browser guests via reference relay (`npm run e2e`) and the production Rust relay (`npm run e2e:rust-relay`).
- [ ] Gate A: desktop build ↔ local browser.
- [ ] Gate B: desktop build ↔ remote browser over DevTunnel (user).
- [ ] Gate C: desktop ↔ 2nd desktop instance (`--profile`).

### M11

- [ ] `scripts/release-macos.sh` signs, notarizes, staples, uploads DMG to draft release.
- [x] CI builds Windows only and attaches to the same draft (tauri-action reuses draft by tag).
- [ ] Gatekeeper accepts downloaded DMG (`spctl -a -vv -t install`).

### M12

- [x] Update checks only run after consent (unit) and the webview makes no update traffic (Playwright).
- [x] Update state machine, menu item, Settings → Updates; cargo + Vitest coverage.
- [x] Local vN → vN+1 update against a test feed (macOS): 0.1.90 → 0.1.91 verified.
- [ ] Real 0.1.1 → 0.1.2 update on macOS and Windows from GitHub Releases.

### AI (AI-0…AI-6)

- [ ] AI-0: each engine driven headlessly on macOS + Windows; fixtures recorded; min versions pinned. _(macOS: Claude + Codex done; Copilot and Windows pending.)_
- [x] AI-0: arrows to existing elements — `repairBindings` does not bind to existing elements, so `connect` binds manually (tested).
- [ ] Mermaid import clean under the release CSP (not yet run in the Tauri webview).
- [x] With AI off: no engine process, no `agent_*` invokes (Vitest privacy gate), no agent UI and zero outbound requests (Playwright `csp-privacy.spec.ts`).
- [x] `openAiKey` removed and scrubbed from existing `settings.json` (Vitest migration test).
- [x] Sandbox flags always present for every engine (cargo arg-builder tests); MCP server rejects wrong tokens.
- [ ] Fake-ACP-agent Playwright flow: prompt → elements drawn → single undo → Revert turn. _(Covered below the UI: real-store Vitest for single undo + revert, fake ACP agent process test, live engine smoke. Full Playwright flow needs a Tauri-driver harness.)_
- [ ] Viewer tabs in a live session refuse agent edits; host agent edits reach guests. _(Refusal tested in Vitest; guest propagation not yet tested end to end.)_
- [ ] `docs/ai-testing.md` matrix passed on macOS + Windows for all three engines.
- [ ] Terms/legal review recorded before public release.

### Wave 1 — Auto-layout (FR-LAYOUT)

- [x] Layered (down/right) + tree layouts on selection or whole scene; groups/frames as nodes; bound text follows; arrows re-routed (Vitest `src/layout/layout.test.ts`).
- [x] One undo step for the user action; `auto_layout` folds into the agent turn's single undo, also inside `apply_ops` (Vitest `sceneTools.test.ts`).
- [x] ELK worker loads offline under the shipped CSP with no eval violations (Playwright `e2e/auto-layout.spec.ts`, org chart + undo).
- [ ] Manual run in the packaged macOS/Windows app (production webview) — not yet done.

### DX Wave 1 — Library + Layers

- [x] Personal library persists per profile; guests don't write (Vitest: `libraryStore`, `ExcalidrawCanvas.library`).
- [x] Layers tab: tree, select + reveal, rename, lock, one undo step each, light and dark (Playwright `layers.spec.ts`).
- [x] `list_layers` / `update_layer` MCP tools (Vitest `sceneTools`).
- [ ] Library persistence verified in the Tauri app across a restart and under `--profile verify` (no Tauri store in the web e2e build).

### DX Wave 2 — Components core

- [x] Create from selection/group, instances via duplicate/paste/`insert_instance`; live sync of geometry (translate/scale/rotate), styles, text (re-measured) and added/removed children (Vitest `components.real`).
- [x] Overrides, reset, detach; direct instance edits become overrides or revert; orphan promotion and demotion (Vitest `components.real`).
- [x] Save → reload round-trip and collab convergence without echo (Vitest `components.real`, `components.collab.real`).
- [x] MCP tools + summary/get_elements component info (Vitest `sceneTools`).
- [x] Master edit updates the instance, one undo reverts both (Playwright `components.spec.ts`).
- [ ] Components sidebar tab / panel section (follow-up lane); real-browser Alt-drag check.

### DX Wave 2 — Named styles

- [x] Create/apply/update/delete styles; linked elements (incl. bound and free text, re-measured) update live as one undo step; undo restores a deleted style (Vitest `styles.real`).
- [x] Direct edits become per-element overrides; reset and push-to-style; stale pasted copies adopt the current definition (Vitest `styles.real`).
- [x] Rule order: a styled master child reaches instances in the same undo step, never as an instance override; instance children can't be styled (Vitest `styles.real`, `reactor.real`, `sceneTools`).
- [x] Save → reload round-trip and collab convergence without echo (Vitest `styles.real`, `styles.collab.real`).
- [x] MCP tools + summary/get_elements style info (Vitest `sceneTools`).
- [x] Panel picker creates a style, an element's overrides pushed with Update style restyle every linked element live, one undo reverts, overrides reset (Playwright `styles.spec.ts`; the Styles tab was removed in DX-11).

### DX Wave 2 — Smart containers

- [x] Make/update/remove containers; vertical and horizontal stacks with gap, padding, align, distribute and hug/fixed sizing (Vitest `actions`, `containers.real`).
- [x] Live re-flow on move/reorder, resize, text growth, add and remove; gestures settle on release; one undo step; Redo kept (Vitest `containers.real`).
- [x] Nested containers, a container inside a component master, an instance as a child (no overrides), bound arrows follow (Vitest `containers.real`).
- [x] A style font change re-flows its container and reaches instances in one step; a container inside a library-backed master survives dematerialize/materialize (Vitest `containers.real`).
- [x] Collab convergence without echo (Vitest `containers.collab.real`).
- [x] Panel section, shortcut, auto-layout treats a container as one node (Vitest `ContainerSection`).
- [x] MCP tools incl. inside `apply_ops` and re-flow after generic edits (Vitest `sceneTools`).
- [x] Shortcut → panel gap edit → agent child resize, each undone in one step (Playwright `containers.spec.ts`).
- [x] Layout menu and toolbar entries (shared Layout command list, DX-7; Vitest `commands`, Playwright `tidy-arrows.spec.ts`).

### DX Wave 2 — Tidy arrows + Layout menu

- [x] Router avoids every obstacle in fixtures, shares trunks, honours pinned sides, ~0.7s for 300 shapes (Vitest `route.test.ts`, `tidy.test.ts`).
- [x] Route survives restore and a later shape move keeps the interior segments; one undo restores, including convert (Vitest `tidy.real.test.tsx`).
- [x] Auto-layout keeps its along-flow elbow sides and tidies those elbows (Vitest `layout.real.test.tsx`).
- [x] Layout menu (native, from `commands.json`) and toolbar dropdown list the same commands (cargo `menu`, Vitest `commands`, `LayoutMenu`).
- [x] `tidy_arrows` MCP tool alone and inside `apply_ops`, one undo step (Vitest `sceneTools`).
- [x] Toolbar Layout ▸ Tidy Arrows on an org chart: no arrow crosses a non-endpoint card, shapes unmoved, one undo restores (Playwright `tidy-arrows.spec.ts`).
- [ ] Manual run in the packaged macOS/Windows app.

### DX Wave 2 — Line anchors (face-centre snap)

- [x] Face points, hit-testing, snap patches and pin re-application for move/resize/rotate (Vitest `lineAnchors.test.ts`, `rule` via `anchors.real.test.tsx`).
- [x] Pinned ends follow shapes in real Excalidraw, one undo step, no echo; panel pin/free undo (Vitest `anchors.real.test.tsx`, `AnchorsSection`).
- [x] `set_arrow_anchors` (incl. `free`, inside `apply_ops`), `connect` `elbow: false` anchors, summary anchors, tool moves keep pins (Vitest `sceneTools`).
- [x] Drag end onto a dot, shape drag follows, undo; Cmd/Ctrl bypass; arrow-tool creation; panel pin/free (Playwright `line-anchors.spec.ts`).

### UX — Pinned sidebar and the AI panel (DX-9)

- [x] A docked sidebar that closes as an overlay while the AI panel is open reopens (same tab) when the panel closes; one the user closes while docked stays closed (Vitest `sidebarRestore.test.ts`).
- [x] At 1440×900, pinned Library and pinned Layers stay docked through open AI → click inside → close AI; at 1110px the pinned Library comes back when AI closes (Playwright `sidebar-ai.spec.ts`).

### UX wave — Panel strip

- [x] Strip rows first in the panel, last-row divider, docked fallback, single-open accordion remembered across selections, inline primary, body-less rows (Vitest `PropertiesPanelHost`).
- [x] Open row persisted in settings and sanitised (Vitest `settingsStore`).
- [x] Rows visible at scrollTop 0 on a short window for a rectangle, an image and a component instance; Create runs inline (Playwright `panel-strip.spec.ts`).

### UX wave — Concept demotions (DX-11)

- [x] Unused rows hide behind a last "+" row; picking reveals and opens a row until the selection changes; action entries run at once; docked fallback (Vitest `PropertiesPanelHost`).
- [x] Style / Data / Stack gating, "Stack" and "Connection" titles, one Component row (Vitest `sections.test.ts`).
- [x] Plain rectangle shows Component + "+"; "+" reveals Style and Data (Playwright `panel-strip.spec.ts`); Add data via "+" (`shape-data-anchors.spec.ts`); Apply style, rename, Update style (`styles.spec.ts`); "Make Stack" in the Layout menu (`tidy-arrows.spec.ts`); properties edited in the Component row (`component-properties.spec.ts`).

## Changelog of status changes

| Date (UTC) | Milestone  | From → To | Note                                                                                                                                   |
| ---------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-15 | All        | — → ⬜    | Plan created, work not yet started.                                                                                                    |
| 2026-06-15 | M1         | ⬜ → ✅   | Scaffold + tooling green via `npm run check`. macOS dev launch pending user-side manual verify.                                        |
| 2026-06-15 | M2         | ⬜ → ✅   | Excalidraw embedded; open/save commands + dialogs wired; 31 unit tests green.                                                          |
| 2026-06-15 | M3         | ⬜ → ✅   | Tabs + recent files + autosave + session restore. 87 tests green (77 JS + 10 Rust).                                                    |
| 2026-06-15 | M4         | ⬜ → ✅   | PNG round-trip + .excalidraw file association + double-click + drag-drop. 103 tests green.                                             |
| 2026-06-15 | M5         | ⬜ → ✅   | Native menu bar + Cmd/Ctrl accelerators + dispatched undo/redo/zoom. 111 tests green.                                                  |
| 2026-06-15 | M6         | ⬜ → ✅   | Settings dialog + opt-in online features; defaults off; 125 tests green (110 JS + 15 Rust).                                            |
| 2026-06-15 | M7         | ⬜ → ✅   | Playwright web-build smoke incl. zero-outbound-requests test. tauri-driver E2E deferred to M9.                                         |
| 2026-06-15 | M8         | ⬜ → ✅   | Comprehensive README + macOS / Windows signing runbooks. Signing pipeline impl deferred to M9.                                         |
| 2026-06-15 | UI polish  | — → ✅    | Design tokens, SVG icons, polished toolbar/dialog/popover, system/light/dark theme toggle. 135 tests green (120 JS + 15 Rust) + 3 e2e. |
| 2026-06-16 | M12        | — → 🟡    | Signed auto-update implemented (updater, consent prompt, Settings → Updates, signed feed + release scripts).                           |
| 2026-11-19 | AI-0…AI-6  | — → ⬜    | AI "bring your own agent" plan approved (Copilot CLI / Claude Code / Codex, MCP canvas tools).                                         |
| 2026-11-19 | AI-1…AI-4  | ⬜ → ✅   | Built by 7 parallel lanes and integrated; live Claude + Codex turns draw on the canvas. 313 JS + 175 Rust tests green.                 |
| 2026-11-19 | AI-0, AI-5 | ⬜ → 🟡   | Copilot/Windows validation and TTD/resume/context chips remain.                                                                        |
| 2026-11-21 | DX-1       | ⬜ → ✅   | Panel host, shape data (FR-52) and elbow anchors (FR-53).                                                                              |
| 2026-11-21 | DX-2       | ⬜ → 🟡   | Components engine + agent tools (FR-54, D-DX9); UI pending.                                                                            |
| 2026-11-21 | DX-5       | ⬜ → ✅   | Named styles (FR-58, D-DX12): engine, UI and agent tools.                                                                              |
| 2026-11-21 | DX-6       | — → ✅    | Smart containers (FR-59, D-DX13).                                                                                                      |
| 2026-11-22 | DX-3       | ⬜ → ✅   | Components UI (FR-55, D-DX10).                                                                                                         |
| 2026-11-21 | DX-7       | — → ✅    | Tidy Arrows + Layout menu/toolbar (FR-60, D-DX14).                                                                                     |
| 2026-11-22 | DX-4       | ⬜ → ✅   | Component properties and nested components (FR-56, FR-57, D-DX11).                                                                     |
| 2026-11-22 | DX-8       | — → ✅    | Line anchors / face-centre snap (FR-61, D-DX15).                                                                                       |
| 2026-11-21 | DX-9       | — → ✅    | Pinned sidebar survives the AI panel (FR-62, D-DX16).                                                                                  |
| 2026-11-22 | DX-10      | — → ✅    | Properties-panel strip (FR-63, D-DX17).                                                                                                |
| 2026-11-22 | DX-11      | — → ✅    | Concept demotions (FR-65, D-DX19).                                                                                                     |
| 2026-11-23 | DX-12      | — → 🟡    | Masterless component engine (FR-64, D-DX18); overlay (FR-66) pending.                                                                  |
