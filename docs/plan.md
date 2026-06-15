# Excalidraw Desktop — Implementation Plan

> Companion to `docs/requirements.md`. Tracks how we'll build the app, in what order, with what tools, and why. Status of each milestone lives in `docs/status.md`.

---

## 1. Architecture overview

```
┌──────────────────────── Tauri 2 app ────────────────────────┐
│                                                              │
│  ┌─────────────── Webview (Vite + React + TS) ───────────┐  │
│  │                                                        │  │
│  │   ┌────────── App shell ──────────┐                    │  │
│  │   │  Tab bar | Settings dialog    │                    │  │
│  │   └───────────────────────────────┘                    │  │
│  │   ┌────── @excalidraw/excalidraw ─────┐                │  │
│  │   │   (official React component)      │                │  │
│  │   └───────────────────────────────────┘                │  │
│  │                                                        │  │
│  │   IPC: invoke() ───────────────▶ Rust commands         │  │
│  │   Event listeners ◀─────────── Rust events             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────────── Rust core (src-tauri) ─────────────┐  │
│  │  • File I/O commands (open, save, save_as, export_png)│  │
│  │  • Recent-files store (tauri-plugin-store)            │  │
│  │  • Settings store (toggles, last session)             │  │
│  │  • Native menu (tauri::menu)                          │  │
│  │  • Single-instance routing (tauri-plugin-single-instance) │
│  │  • Deep-link / file-association handler               │  │
│  │  • Keychain access (tauri-plugin-keyring) for secrets │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## 2. Tech stack (locked-in decisions)

| Concern            | Choice                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Shell              | **Tauri 2.x** (Rust core + WebView2/WKWebView)                                                                |
| Frontend bundler   | **Vite**                                                                                                      |
| Frontend framework | **React 18 + TypeScript** (required by `@excalidraw/excalidraw`)                                              |
| Package manager    | **npm**                                                                                                       |
| Editor             | **`@excalidraw/excalidraw`** npm package, embedded React component                                            |
| State (frontend)   | **Zustand** for tab/session state (light, no boilerplate)                                                     |
| Persisted store    | `tauri-plugin-store` (JSON on disk, in app data dir)                                                          |
| Secrets            | `tauri-plugin-keyring` (Keychain on macOS, Credential Manager on Windows)                                     |
| Single instance    | `tauri-plugin-single-instance`                                                                                |
| File associations  | Tauri 2 `bundle.fileAssociations` + `tauri-plugin-deep-link` (Windows) + macOS `LSHandlerRank` (auto-emitted) |
| Frontend tests     | **Vitest** + React Testing Library                                                                            |
| Rust tests         | `cargo test`                                                                                                  |
| End-to-end tests   | **Playwright** driving **tauri-driver** (WebDriver)                                                           |
| Lint               | `eslint` (TS) + `cargo clippy -- -D warnings` (Rust)                                                          |
| Format             | `prettier` (TS) + `cargo fmt` (Rust)                                                                          |
| CI                 | GitHub Actions (build/test matrix on macOS + Windows runners)                                                 |

## 3. Repository layout

```
excalidraw-app/
├── .claude/
│   ├── commands/                # Custom slash commands for Claude Code
│   │   ├── new-tauri-command.md
│   │   ├── bump-excalidraw.md
│   │   └── release-checklist.md
│   └── agents/                  # Subagent definitions
│       ├── tauri-architect.md
│       └── excalidraw-integrator.md
├── .github/
│   └── workflows/
│       ├── ci.yml               # lint + test on PRs
│       └── release.yml          # build matrix (documented, disabled in v1)
├── docs/
│   ├── requirements.md
│   ├── plan.md                  # this file
│   ├── status.md
│   ├── signing-macos.md         # local notarization walkthrough (deferred)
│   └── signing-windows.md       # local Authenticode walkthrough (deferred)
├── src/                         # React frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── ExcalidrawCanvas.tsx
│   │   ├── TabBar.tsx
│   │   └── SettingsDialog.tsx
│   ├── stores/
│   │   ├── tabsStore.ts
│   │   ├── settingsStore.ts
│   │   └── recentFilesStore.ts
│   ├── ipc/
│   │   └── commands.ts          # typed wrappers over invoke()
│   ├── lib/
│   │   ├── fileFormat.ts        # JSON / PNG-with-scene detection
│   │   └── autosave.ts
│   └── __tests__/               # Vitest co-located OR here
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── icons/
│   ├── capabilities/
│   │   └── default.json         # Tauri 2 capabilities (allowlist)
│   └── src/
│       ├── main.rs
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── files.rs         # open, save, save_as, export_png
│       │   ├── recent.rs
│       │   └── settings.rs
│       ├── menu.rs
│       ├── associations.rs      # double-click + drag-drop routing
│       └── lib.rs
├── e2e/
│   └── smoke.spec.ts            # Playwright + tauri-driver
├── CLAUDE.md
├── README.md
├── package.json
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```

## 4. Milestones

> Status of each is tracked in `docs/status.md`. Order is roughly sequential but small reshuffles are fine.

### M1 — Project scaffold

- `npm create tauri-app@latest` with `react-ts` template; switch to npm; pin Tauri 2.
- Replace default content with a "Hello Excalidraw" placeholder.
- Wire `eslint`, `prettier`, `tsc --noEmit`, `cargo fmt`, `cargo clippy`.
- Verify `npm run tauri dev` launches on macOS and Windows.

### M2 — Excalidraw embedded + basic open/save

- Install `@excalidraw/excalidraw`. Render full editor in `ExcalidrawCanvas.tsx`.
- Rust commands: `open_file(path) -> FileContents`, `save_file(path, json) -> ()`.
- Typed TS wrappers in `src/ipc/commands.ts`.
- Hook into Excalidraw's `onChange` to detect dirty state.
- Manual test: open a `.excalidraw` from a chosen path, edit, save back.

### M3 — Tabs, recent files, autosave, session restore ✅

**Done. Final design:**

- Zustand `tabsStore` with `{ id, path, dirty, initialData }`. Smart `openTab` reuses an existing tab if the same path is already open and replaces the lone untouched blank tab on cold start so the first open doesn't leave a stray Untitled.
- `TabBar.tsx`: middle-click close, × button, + new-tab button, dirty marker.
- `ConfirmCloseDialog.tsx`: in-app 3-way modal (Save / Don't Save / Cancel). Built ourselves because `@tauri-apps/plugin-dialog` only exposes 2-way ask/confirm.
- `App.tsx` mounts one Excalidraw instance per tab in `.canvas-slot` divs and toggles visibility, so per-tab undo history (FR-9) survives tab switches.
- `recentFilesStore.ts` via `tauri-plugin-store` (`recent-files.json`): dedupe, cap 20, most-recent first. `RecentMenu.tsx` exposes it in the toolbar; the M5 native menu will share the list.
- `src/lib/autosave.ts` + Rust scratch commands (`write_scratch` / `read_scratch` / `delete_scratch` / `list_scratch`): 2s debounced per-tab. File-backed tabs overwrite their path (modern macOS document model); untitled tabs go to `<appDataDir>/scratch/<tabId>.excalidraw` and stay dirty so the user is still nudged to Save. Scratch is sanitized server-side to `[A-Za-z0-9_-]{1,128}`.
- `sessionStore.ts` persists `{ tabs: [{ id, path }], activeTabId }` to `session.json` on every store change. On launch, files are reopened, untitled tabs are matched to scratch entries by tab id, missing files are silently dropped (console warn). If everything is skipped, `ensureActiveTab()` seeds a blank tab as usual.
- 77 JS + 10 Rust = 87 tests green.

### M4 — PNG export with embedded scene + file associations ✅

**Done. Final design:**

- `src/lib/pngScene.ts`: `exportSceneAsPng` forces `appState.exportEmbedScene = true` so the scene survives regardless of editor state; `loadScenePng` round-trips via Excalidraw's `loadFromBlob` and returns `null` on failure.
- `src/lib/fileFormat.ts`: `looksLikePng` (magic check), `base64ToBytes` / `bytesToBase64` (chunked for big buffers), `formatFromExtension`.
- Rust: `read_file_bytes` + `write_file_bytes` (base64 over IPC because Tauri serializes `Vec<u8>` as a JSON array, which is huge for a 200 KB PNG). New `base64` crate.
- `tauri.conf.json` `bundle.fileAssociations`: `.excalidraw` registered as Editor with MIME `application/vnd.excalidraw+json`.
- `tauri-plugin-single-instance` initialized as the first plugin so a second double-click routes argv to the running window via `excalidraw://file-open`.
- macOS file-open: `RunEvent::Opened { urls }` in `app.run`. Win/Linux: parse argv in `setup`. Same event name in both paths.
- Drag-drop: `getCurrentWebview().onDragDropEvent` → flatten paths → `openPath`.
- `openPathRef` so the long-lived event subscription always calls the freshest `openPath` closure without re-subscribing.
- 90 JS + 13 Rust = 103 tests green.

### M5 — Native menus & keyboard shortcuts ✅

**Done. Final design:**

- `src-tauri/src/menu.rs`: builds the menu with `MenuBuilder` + `SubmenuBuilder`. macOS gets the standard app menu (About, Services, Hide/Show, Quit) prepended; other platforms put Quit under File. Five custom-item submenus: File (New/Open/Save/Save As/Export PNG/Close Tab), Edit (custom Undo/Redo + predefined Cut/Copy/Paste/Select All), View (Zoom In/Out/Reset, Fullscreen), Window (Minimize/Maximize/Bring All To Front on mac), Help (About/Documentation).
- Stable IDs under `excalidraw:*` namespace, listed in `menu::ids`. Cargo test enforces ID stability; the frontend `MENU_ITEM_IDS` array mirrors them.
- Accelerators are written with `$Mod` and resolved to `Cmd` (macOS) or `Ctrl` (everywhere else) by a `cfg`-gated constant.
- `app.on_menu_event(menu::forward_menu_event)` re-emits custom items to the frontend on `excalidraw://menu`. Predefined items (Cut/Copy/Paste/Select All/Quit/Minimize/Maximize/Fullscreen) are handled by the OS directly.
- Frontend: `src/ipc/menuEvents.ts` exposes the typed `MenuItemId`, an `onMenuEvent` subscriber, and a `dispatchShortcut` helper. App.tsx subscribes once at mount via a `menuActionRef` so its `handleMenuAction` closure is always called fresh. Undo/Redo/Zoom dispatch a synthetic keydown into the document because Excalidraw owns its history stack and does not respond to the OS "undo:" responder.
- 96 JS + 15 Rust = 111 tests green.

### M6 — Settings dialog + opt-in online features ✅

**Done. Final design:**

- `src/stores/settingsStore.ts`: Zustand store of three booleans (`collab`, `library`, `ai`) and two secrets (`openAiKey`, `firebaseConfig`). Persisted via `tauri-plugin-store` to `<appData>/settings.json`. A `sanitize()` step on load ignores wrong-typed values so a tampered file degrades to defaults. `resetAll()` is exposed for the dialog and tests.
- `src/components/SettingsDialog.tsx`: modal with one toggle per feature, a hint describing what data leaves the device, two password/textarea secret fields, a loud "values stored unencrypted on disk" warning, plus Done and Reset-all buttons. Closes on Esc or backdrop click.
- `src/components/ExcalidrawCanvas.tsx`: now accepts `aiEnabled` / `isCollaborating` / `libraryReturnUrl`. All three default to off / undefined so the editor stays fully offline unless a flag is true.
- `src/App.tsx`: `loadSettings()` runs on mount; toggle values are read each render and passed into every `ExcalidrawCanvas`. Dialog opens from the toolbar `Settings` button or from the native `excalidraw:file:settings` menu item.
- Native menu (`src-tauri/src/menu.rs`): on macOS the Settings item lives in the App menu (between About and Services) with `Cmd+,`; on Win/Linux it goes into File with `Ctrl+,`.

**Follow-ups deferred post-v1:**

- Native keychain integration for secrets (replace plain `settings.json` storage with the OS keyring).
- Library: when `library` is true, optionally surface a toolbar button that opens libraries.excalidraw.com in the system browser via `tauri-plugin-opener` (today Excalidraw itself handles the library UI once we pass `libraryReturnUrl`).
- CSP relaxation per-toggle (currently CSP is open enough for the embedded editor; revisit when adding remote endpoints).

### M7 — Tests ✅

**Done. Final design:**

- **Vitest (110 tests across 16 files)**: file format detection, scene serialization, tabs/recent/session/settings stores, autosave debouncing, PNG round-trip, the menu/open event subscribers, every component (Toolbar, TabBar, RecentMenu, ConfirmCloseDialog, SettingsDialog), and a smoke render of App.
- **cargo test (15 tests)**: `commands::files` round-trip via `tempfile`, `commands::scratch` sanitization (security boundary), `menu` accelerator mapping + ID drift detector, and `error` serialization shapes.
- **Playwright (`npm run e2e`, 3 tests against `vite preview`)**:
  1. Editor shell renders end-to-end.
  2. Settings dialog opens with every online toggle off.
  3. **Zero outbound requests** when all toggles are off (FR-18 / privacy invariant).
- Web-preview compatibility required adding `isTauri()` guards in `src/ipc/commands.ts` and try/catch around event subscriptions in `App.tsx`. Real bug found and fixed in `tabsStore.markDirty` (was allocating a new array on every change, eventually breaching React's max update depth in the preview build).

**Deferred to M9 / post-v1:** `tauri-driver`-based native shell automation (file associations, drag-drop, native menus running through the actual webview). The Playwright web suite covers the React layer end-to-end today.

### M8 — Docs polish + signing/notarization documentation (deferred impl)

- `docs/signing-macos.md`: Developer ID prerequisites, `codesign` flags, `notarytool submit --wait`, stapling, troubleshooting.
- `docs/signing-windows.md`: cert acquisition options (EV, OV, Azure Trusted Signing), `signtool` invocation, timestamp servers, MSI vs NSIS trade-offs.
- README quickstart: install, dev, build, test.

### M9 — Deferred for post-v1

- CI release pipeline that actually signs and publishes.
- Auto-update via `tauri-plugin-updater`.
- Linux builds.

## 5. Tauri capabilities (minimal allowlist)

`src-tauri/capabilities/default.json` will grant only:

- `fs:default` scoped to user-selected paths (via `tauri-plugin-fs` dialog-driven scopes).
- `dialog:default` (open/save/message).
- `path:default`, `os:default`.
- `store:default` (recent + settings).
- `deep-link:default`, `single-instance:default`.
- `opener:default` (for external URLs only, behind settings).
- `keyring:default` for secrets.

## 6. CSP

Default `Content-Security-Policy`:

```
default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: https://ipc.localhost
```

When AI is enabled at runtime, append `https://api.openai.com` to `connect-src`. When collab is enabled, append the user's Firebase region domain.

## 7. Decisions log

| #   | Decision                                            | Why                                                                     |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| D1  | Embed `@excalidraw/excalidraw` React component      | Self-contained npm package, no server needed, easy upstream bumps.      |
| D2  | Tauri 2.x                                           | Current stable; better plugin ecosystem; first-class file associations. |
| D3  | JSON + PNG-with-scene formats                       | Covers the common roundtrip; PNG shareable while still editable.        |
| D4  | Single window with tabs                             | Matches user expectation; simpler state than multi-window.              |
| D5  | Recent files + autosave + session restore           | Standard native-app expectation.                                        |
| D6  | npm + Vite + React + TS                             | User preference; React is required by Excalidraw.                       |
| D7  | Vitest + cargo test + Playwright via tauri-driver   | Layered coverage from units to full app smoke.                          |
| D8  | Online features opt-in via settings, off by default | User wants the capability but no data leaving the box by default.       |
| D9  | Signing/notarization documented, deferred           | User asked for docs without implementation in v1.                       |

## 8. Risks & mitigations

| Risk                                                                              | Mitigation                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@excalidraw/excalidraw` API changes between minor versions                       | Pin exact version; bump via `/bump-excalidraw` skill which runs smoke tests.  |
| Windows file association requires deep-link plumbing + single-instance            | Use both plugins together; covered by Playwright smoke test for double-click. |
| PNG-with-scene metadata fragile (stripped by some tools)                          | Keep `.excalidraw` JSON as authoritative; PNG is a sharing convenience only.  |
| Tauri webview differences (WKWebView vs WebView2) cause Excalidraw rendering bugs | Run vitest + playwright on both runners in CI before tagging a release.       |
| User enables collab/AI then leaks data unintentionally                            | Toggles default off; warning copy in settings; CSP only widened when enabled. |

## 9. Skills & agents (Claude Code)

Definitions live under `.claude/`. Tracked in `CLAUDE.md` § "Skills & Agents".

**Slash commands** (`.claude/commands/*.md`):

- `/new-tauri-command <name>` — scaffold a Rust command in `src-tauri/src/commands/`, register it, generate a typed TS wrapper, and create a Vitest + cargo test stub.
- `/bump-excalidraw` — update `@excalidraw/excalidraw`, run `npm test`, run Playwright smoke, report breaking changes.
- `/release-checklist` — walk through pre-release validation (lint, tests, version bump, changelog).

**Subagents** (`.claude/agents/*.md`):

- `tauri-architect` — designs new Tauri commands/IPC flows with capability/CSP impact called out.
- `excalidraw-integrator` — knows the `@excalidraw/excalidraw` API surface; pairs it with our React shell.

---

_Last updated by the planning pass; further updates happen as milestones progress (see `docs/status.md`)._
