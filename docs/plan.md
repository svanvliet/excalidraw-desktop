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
- Hook into Excalidraw's `onChange` to detect dirty state. Only content changes count: `src/lib/sceneContent.ts` fingerprints element versions, attached files and background color, so selection/scroll/zoom don't re-dirty a saved file.
- Manual test: open a `.excalidraw` from a chosen path, edit, save back.

### M3 — Tabs, recent files, autosave, session restore ✅

**Done. Final design:**

- Zustand `tabsStore` with `{ id, path, dirty, initialData }`. Smart `openTab` reuses an existing tab if the same path is already open and replaces the lone untouched blank tab on cold start so the first open doesn't leave a stray Untitled.
- `TabBar.tsx`: middle-click close, × button, + new-tab button, dirty marker.
- `ConfirmCloseDialog.tsx`: in-app 3-way modal (Save / Don't Save / Cancel). Built ourselves because `@tauri-apps/plugin-dialog` only exposes 2-way ask/confirm.
- `App.tsx` mounts one Excalidraw instance per tab in `.canvas-slot` divs and toggles visibility, so per-tab undo history (FR-9) survives tab switches.
- `recentFilesStore.ts` via `tauri-plugin-store` (`recent-files.json`): dedupe, cap 20, most-recent first. `RecentMenu.tsx` exposes it in the toolbar, and App mirrors it into the native File → Open Recent submenu via `set_recent_menu` (`src-tauri/src/commands/system.rs`); clicking an item routes through the normal file-open flow. OS file-open requests are queued in Rust (`OpenQueue`) until the frontend calls `file_open_ready`, so a Finder double-click that cold-launches the app isn't dropped.
- `src/lib/autosave.ts` + Rust scratch commands (`write_scratch` / `read_scratch` / `delete_scratch` / `list_scratch`): 2s debounced per-tab. File-backed tabs overwrite their path (modern macOS document model); untitled tabs go to `<appDataDir>/scratch/<tabId>.excalidraw` and stay dirty so the user is still nudged to Save. Scratch is sanitized server-side to `[A-Za-z0-9_-]{1,128}`. The `autosave` setting (default on) gates the file write; when off, file-backed tabs are backed up to scratch under their tab id, session restore prefers that backup (dirty), and Save/Save As/Close delete it.
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

- `src/stores/settingsStore.ts`: Zustand store of three booleans (`collab`, `library`, `ai`) and two secrets (`openAiKey`, `firebaseConfig`). Persisted via `tauri-plugin-store` to `<appData>/settings.json`. A `sanitize()` step on load ignores wrong-typed values so a tampered file degrades to defaults. `resetAll()` is exposed for the dialog and tests. _(`openAiKey` is removed in AI-1; see D-AI7.)_
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

### M8 — Docs polish + signing/notarization documentation (deferred impl) ✅

- ✅ `docs/signing-macos.md`: Developer ID prerequisites, `codesign --options runtime` + entitlements, `notarytool store-credentials` + `submit --wait`, `stapler staple`, troubleshooting table. Includes Tauri 2 `bundle.macOS.signingIdentity`/`hardenedRuntime` config.
- ✅ `docs/signing-windows.md`: cert acquisition options (Standard / EV / **Azure Trusted Signing recommended**), `azuresigntool` and classic `signtool sign` invocations with timestamping, MSI/NSIS coverage, troubleshooting table, optional SmartScreen reputation submission, Tauri 2 `bundle.windows.certificateThumbprint` wiring.
- ✅ README quickstart: install, dev, build, test, e2e, scripts table, project layout, signing pointers.

**Deferred to M9:** the actual signed-release pipeline (the docs are copy-pasteable so a future developer or CI workflow can follow them verbatim).

### UX polish (post-M8, pre-v1) ✅

A visual pass over the in-window chrome. The native menu bar (M5) was
already polished by the OS; the React-side toolbar / tabs / dialog
were boilerplate from earlier milestones and needed work before we
called v1 shippable.

- **Design tokens** in `src/styles/tokens.css`: two-layer system
  (primitive grayscale + accent scales → semantic vars like
  `--bg-elevated`, `--fg-muted`, `--border-subtle`). Dark mode is a
  data-attribute override (`:root[data-theme="dark"]`), not a media
  query, so the user pref always wins. A `prefers-color-scheme`
  fallback kicks in only when `data-theme` is unset (i.e. before JS
  boots).
- **Icon set** in `src/components/icons.tsx`: lucide-style 24×24
  stroke SVG components rendered at 16px, tinted with `currentColor`
  so they inherit button color. No icon font, no PNG sprite.
- **Theme store + toggle**: `src/stores/themeStore.ts` is a
  Zustand store with `mode: system | light | dark` and
  `resolved: light | dark`. Persisted via `tauri-plugin-store`
  (`settings.json`, key `theme`) using the same pattern as
  `settingsStore`. A live `matchMedia('(prefers-color-scheme: dark)')`
  listener keeps `resolved` in sync when the OS appearance changes,
  but only while `mode === "system"`. The store applies
  `data-theme` to `<html>` so all CSS tokens flip atomically.
  `<ThemeToggle>` cycles `system → light → dark → system` and lives
  in the toolbar with a Monitor/Sun/Moon icon.
- **Excalidraw theme prop**: `ExcalidrawCanvas` accepts an optional
  `theme: "light" | "dark"` prop and forwards it. `App.tsx` reads
  `resolvedTheme` from the store and passes it to every canvas
  instance so the editor chrome matches the host theme.
- **Toolbar / tabs / popover / modal**: rebuilt against the tokens.
  Toolbar buttons are icon-first with text for primary actions
  (Open, Save, Save As) and icon-only with `aria-label` + `title`
  for secondary actions (Export PNG, Settings, Theme). Settings
  modal now has a real header / scrollable body / sticky footer,
  styled toggle switches (custom `appearance: none` checkbox), and
  a soft entry animation.

**Tests:** `themeStore.test.ts` (7 cases including system-pref
detection, persistence, cycle order, live OS-change reaction, and
malformed-persisted-value fallback) + `ThemeToggle.test.tsx` (3
cases). Existing 110 Vitest + 15 cargo + 3 Playwright suites
continue to pass.

### M9 — Deferred for post-v1

- CI release pipeline that actually signs and publishes. _(Superseded by M11.)_
- Auto-update via `tauri-plugin-updater`. _(Superseded by M12.)_
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

The updater (M12) adds **no** capability: the webview never calls the plugin's JS API; it uses the app's own `update_status` / `update_check` / `update_install` commands, which run the plugin from Rust.

The AI agent (AI-1…AI-6) adds **no** capability either. Engine processes are spawned by Rust using fixed argument builders, through the app's own `agent_*` commands. No `shell` plugin or webview process access is granted. Attach-folder reuses `dialog:allow-open`, and file access is enforced on the engine side (the folder is passed as the agent's working directory or `--add-dir`, with writes scoped to it and the session folder).

## 6. CSP

Static allow-list in `src-tauri/tauri.conf.json` (decision D-C3 — chosen over runtime widening because Tauri 2 can't change CSP per-toggle without a reload; the collab origins stay unused unless a session is started, which is itself gated by the `collab` setting):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:;
connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:* https://*.devtunnels.ms
  wss://*.devtunnels.ms https://libraries.excalidraw.com;
frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'
```

Excalidraw fonts are self-hosted (copied to `dist/fonts`, `window.EXCALIDRAW_ASSET_PATH = "/"`) so text never fetches from esm.sh. Tradeoffs: no `'unsafe-eval'` (peers send untrusted scene data), so SVG export embeds full fonts instead of subsets; a desktop guest can only join hosts on `*.devtunnels.ms` or loopback (browser guests are unaffected). `e2e/csp-privacy.spec.ts` guards both. The relay-served guest page sends its own self-only CSP header.

The updater (M12) needs **no CSP change**: `latest.json` and the update artifact are fetched by `tauri-plugin-updater` (reqwest) in Rust, outside the webview. `e2e/csp-privacy.spec.ts` asserts the webview makes no update traffic.

The AI agent needs **no CSP change**. All AI traffic comes from the user's agent process, outside the webview. The MCP server is reached by the engine, not by the webview. Mermaid import (already bundled by Excalidraw) runs without `unsafe-eval`; AI-0 confirms this.

### M10 — Live collaboration (embedded relay + DevTunnels)

Contract: `docs/collab-protocol.md`. Firebase dropped: on excalidraw.com Firebase only _persists_ scenes; realtime goes through a separate socket relay, so Firebase alone never enabled co-editing. Instead:

- `src-tauri/src/collab/` — axum WebSocket relay bound to 127.0.0.1 (room fan-out of opaque encrypted frames, host-registered rooms only, size/peer limits) that also serves the embedded app assets for browser guests; `devtunnel` CLI orchestration (auto) or manual public URL; commands `collab_start/stop/status`, event `collab://status`.
- `src/collab/` — AES-GCM crypto, link encode/decode, WebSocket transport, `CollabSession` sync engine (reconcile, throttled diffs, cursors, files), browser `GuestApp`.
- Share / Join dialogs, settings (display name — defaults to the OS user's full name via `os_user_name` — tunnel mode, manual URL, port); static CSP (§6).
- `npm run e2e:rust-relay` runs the browser-guest spec against the production Rust relay (`src-tauri/examples/relay_standalone.rs`).
- Test profiles (`--profile`) let two desktop instances run on one machine.
- **Validation gate before any release:** (A) desktop build ↔ local browser, (B) desktop build ↔ remote browser over DevTunnel, (C) desktop ↔ second desktop instance. Checklist: `docs/collab-testing.md`.
- Future: same wire protocol on a Cloudflare Worker + Durable Object for always-on links.

### M11 — Local notarized macOS release

`scripts/release-macos.sh` builds the universal DMG locally, signs with the Developer ID cert, notarizes (`notarytool --keychain-profile`), staples, verifies, and uploads to a draft GitHub Release. CI builds only Windows and attaches to the same draft. Runs only after the M10 validation gate passes.

### M12 — Signed auto-update (macOS universal + Windows)

Modeled on tunnel-bar's updater.

- `src-tauri/src/updater.rs`: state machine (idle → checking → upToDate / downloading → ready → installing, or error), event `excalidraw://update-status`, commands in `commands/updater.rs`. Downloads + verifies, holds the bytes, installs only on `update_install`, then `request_restart()`. Disabled in debug builds unless built with `EXCALIDRAW_UPDATE_ENDPOINT` (local tests only).
- Frontend: `autoUpdate: boolean | null` setting, `updateStore` (scheduler gated on consent), `UpdateController` (consent prompt, ready toast, menu handler), Settings → Updates.
- Feed: `https://github.com/svanvliet/excalidraw-desktop/releases/latest/download/latest.json` with `darwin-aarch64` + `darwin-x86_64` (both → the universal `.app.tar.gz`, made from the stapled app) and `windows-x86_64` (NSIS setup.exe). Signed with `tauri signer sign --app-version`; `requireSignedVersion: true`; Windows `installMode: passive`.
- Key: `~/repos/certs/excalidraw-desktop-updater.key` (password in Keychain, service `excalidraw-desktop-updater-key-password`); CI uses the `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` secrets. Release scripts / runbooks: `docs/signing-macos.md`, `docs/signing-windows.md`.

### AI-0…AI-6 — AI agent, bring your own engine

Contract: `docs/ai-integration.md` (engine matrix, sandbox flags, MCP tool contract, canonical event model, UX). Replaces the original "OpenAI key + text-to-diagram" idea: the app drives the user's locally installed, signed-in **Copilot CLI** (`copilot --acp`), **Claude Code** (`claude -p` stream-json), or **Codex** (`codex app-server`, falling back to `exec --json`). It serves canvas tools to whichever engine is used through a loopback MCP server plus a stdio shim (the app's own binary run with `--mcp-shim`).

- **AI-0 Spikes** (no product code):
  - Port the T3 Code pieces listed in `docs/ai-integration.md` § "Reuse from T3 Code" (generated ACP/Codex schemas → Rust types, PATH discovery, fake ACP agent) and add `THIRD_PARTY_NOTICES.md`.
  - A headless driver per engine on macOS and Windows, with recorded event fixtures.
  - MCP shim round-trip.
  - Binding arrows to existing elements (`repairBindings`).
  - Mermaid import under the release CSP.
  - Minimum engine versions.
- **AI-1 Foundation:**
  - Settings migration: drop `openAiKey`; add the `ai` master toggle plus per-engine `{enabled, path?, useHostConfig, model?}` and `defaultEngine`.
  - `src-tauri/src/agent/` with `detect`, a process manager with kill-tree, canonical events, and an `AcpAdapter` tested against a fake ACP agent.
  - The loopback MCP server and `--mcp-shim`.
  - `src/agent/sceneBridge.ts` and the read-only tools.
- **AI-2 Engines:**
  - Copilot ACP, Claude stream-json, and Codex app-server adapters.
  - Fixed sandbox flags, the "use my MCPs/skills/plugins" toggle, permission routing, and error classification.
- **AI-3 Edit tools:**
  - add/update/delete/connect/add_mermaid/arrange/move/duplicate/apply_ops/set_viewport/select/find/get_canvas_state/set_canvas.
  - `expectedRevision` checks, the viewer guard, version bumps and tombstones, `markDirty` plus autosave, and Revert-turn snapshots.
- **AI-4 Panel UX:**
  - Docked per-tab panel, transcript, tool chips, approval cards, Stop/Revert, context chips, Attach folder (writable working folder, session folder shown), and quick actions.
  - Settings → AI engine cards, the first-use disclosure, and View → AI Panel (⌘/Ctrl+Shift+A).
- **AI-5 Polish:**
  - `TTDDialog` backed by the agent, engine session resume, a collab indicator, and redacted prompt logging.
- **AI-6 Validation gate:**
  - `docs/ai-testing.md`: 3 engines × 2 OSes, plus a terms/legal review before public release.

### EXT — Desktop extensions

Contract: `docs/extensions.md`. Built-in modules under `src/extensions/` (`types.ts` contract, `registry.ts`, `runner.ts`, `groups.ts`, `tools.ts`, one folder per extension: `mask/`, `border/`). Image extensions are stages of one pipeline (`stack.ts`, `pipeline.ts`, `raster.ts`): an element carries an ordered chain of intents (shape stages before decorations) in `customData.excalidrawDesktop` (stack format v2; v1 single intents migrate on read), and every change re-renders the original through the whole chain into one PNG. Output is standard elements + files. The same definition drives the image controls injected into Excalidraw's properties panel (`ImagePropertiesPanel`, D-X3) and the generated `apply_extension` / `remove_extension` MCP tools. No new capability or CSP change.

### DX — Library persistence and Layers (Wave 1)

- **Library** (`src/lib/libraryStore.ts`): `onLibraryChange` saves to `<appData>/library.json` through `tauri-plugin-store` (per-profile file name via `storeFile.ts`) and fans changes out to the other open tabs with `updateLibrary`. Canvases opt in with `persistLibrary`; collab guest tabs and the browser guest app pass false. Saving is gated until the stored library has loaded.
- **Sidebar tab host** (`src/components/sidebar/SidebarTabs.tsx`, D-DX4): one component renders extra `DefaultSidebar.TabTriggers` and `Sidebar.Tab`s from a list of `{ tab, title, icon, render }`, so later tabs (Components, Styles) only add a list entry.
- **Layers** (`src/layers/layers.ts` model, `src/components/sidebar/LayersPanel.tsx` UI): the tree is rebuilt from the scene on change; edits go through the agent `Draft` and `commitUndoable` (one undo step), the same path as the `update_layer` tool. Names live in `customData["excalidrawDesktop.layer"]` (`{ v: 1, name?, groups?: { [groupId]: name } }`, D-DX2); group names are stored on every member so they survive partial deletes.
- **Undo of first `customData` writes**: Excalidraw applies undo with `newElementWith`, which skips `undefined`, so undoing a write to an element with no `customData` was a no-op. `commitUndoable` (and turn collapse in `turns.ts`) seed `{}` into the store snapshot first.
- No new capability or CSP change; nothing makes a network call.

### DX wave 1 — Panel host, shape data, elbow anchors

`src/components/propertiesPanel/` (`PropertiesPanelHost`, `panel.ts` section contract, `keyboard.ts` shortcut bridge, `sections.ts` order: image → anchors → data; D-DX4). Shape data: `src/lib/shapeData.ts`, `src/components/shapeData/`, agent tools `set_shape_data` / `get_shape_data` (D-DX2). Anchors: `src/lib/elbowAnchors.ts`, `src/components/arrowAnchors/`, `connect` `startAnchor`/`endAnchor` and `set_arrow_anchors` (D-DX8). Smoke: `e2e/shape-data-anchors.spec.ts`. No new capability or CSP change.

### DX wave 2 — Components core

`src/extensions/components/` (model, geometry, text, sync, rule, duplicate, actions, host) on the reactor (`src/extensions/reactor/`, D-DX1) with `apply: "mutate"`; installed by `ExcalidrawCanvas` and `GuestApp`, reseeded when `initialData` changes, and collab applies go through `remoteApi` (D-DX9). The reactor commits clones with `NEVER` before mutating originals so Excalidraw's store snapshot stays current (see `docs/components.md` §2). Agent tools `create_component`, `insert_instance`, `list_components`, `set_overrides`, `reset_overrides`, `detach_instance`; generic edit tools re-sync the components they touch. Temporary trigger: Alt/Option+Cmd/Ctrl+K (capture-phase keydown, because Excalidraw's hyperlink action claims every Cmd/Ctrl+K). Smoke: `e2e/components.spec.ts`. No new capability or CSP change.

### DX wave 2 — Named styles

`src/extensions/styles/` (model, sync, rule, actions, host) as a second reactor rule installed with components: `[createStyleRule(), createComponentRule()]`. The reactor runs key-level rules in order and chains their writes within a flush (small generic core change, `reactor.real.test.tsx`), so a style edit restyles a master and components carries it to instances in the same undo step, never as an instance override (D-DX12). UI: `src/components/styles/` (properties-panel Style section) and `src/components/sidebar/StylesPanel.tsx` (Styles tab). Agent tools `list_styles`, `create_style`, `apply_style`, `update_style`, `delete_style`, `reset_style_overrides`; `runEdit` runs `syncStylesEdited` before the components sync. Smoke: `e2e/styles.spec.ts`. No new capability or CSP change. See `docs/styles.md`.

### DX wave 2 — Components UI

`src/components/componentsUi/` (Components tab, thumbnails, insert and drag, panel section, master-edit banner, `.excalidrawlib` codec) and `src/lib/componentLibraryStore.ts` (My components: `my-components.json` in app data per profile, images stored per entry, multi-tab fan-out, never wiped on a failed load, read-only for guests; D-DX10). Library-backed inserts use the engine's `materializeMaster` / `dematerializeMaster` / `adoptInstanceAsMaster` (`docs/components.md` §4a, §7a). Native menu: Edit → Create Component (`excalidraw:edit:createComponent`). Agent tools `list_my_components`, `insert_my_component`. Tests: `componentsUi.real.test.tsx` (real Excalidraw) and `e2e/components-ui.spec.ts`. No new capability or CSP change.

### DX wave 2 — Component properties and nested components

Engine in `src/extensions/components/`: properties (`props` declared on the master, `pv` values on instances, `npv` values for nested instances) and multi-component tags (`{ v: 2, tags }`, inner to outer, still `v: 1` when single and plain). `syncCascade` syncs a component, then every outer component whose master it changed, until stable; cycles are rejected at create/insert. Actions `defineProperty` / `removeProperty` / `setProperties` / `instanceProperties` and `insertInstance(..., { into })`, one undo step each through `runComponentCommand`. Agent tools `define_property`, `remove_property`, `set_properties`. UI: `src/components/componentProps/` (properties-panel section `componentProps`). Alt-drag now also detects the swap from z-order, since Excalidraw has moved the originals before `onDuplicate`. Tests: `components.real.test.tsx`, `components.collab.real.test.tsx`, `e2e/component-properties.spec.ts` (incl. a real Alt-drag). No new capability or CSP change (D-DX11).

### DX wave 2 — Smart containers

`src/layout/containers/` (model, stack engine, rule + gesture hold tracker, actions, host, commands) and `src/components/containers/` (Container panel section). The rule shares the components reactor, ordered `[style, container, component]`: a style font change grows text, containers re-flow, components carry both to instances. Reactor additions: `invalidate(ids)` re-flows elements after a gesture ends, and a key-level rule's writes dirty later key-level rules in the same pass, and earlier ones that opt in (`seesLaterWrites`, only containers) in the next pass (bounded by `maxPasses`), so an instance the component rule resizes re-flows its container. Commands are registered in one place, `src/layout/containers/commands.ts` (menu ids `excalidraw:layout:makeContainer` / `:removeContainer`), for the shared Layout menu and toolbar. Shortcut Alt/Option+Shift+A. Six agent tools, all `apply_ops`-capable; agent edits sync styles, then re-flow touched containers, then sync components. Smoke: `e2e/containers.spec.ts`. No new capability or CSP change (D-DX13).

### DX wave 2 — Tidy arrows and the Layout menu

`src/layout/route.ts` (router), `src/layout/tidy.ts` (`tidyArrowsDraft`, `tidyAfterLayout`), `src/layout/canvasAction.ts` (`tidyArrowsCanvas`), `src/layout/commands.json` + `commands.ts` (shared Layout command list), `src/components/LayoutMenu.tsx` (toolbar dropdown, `LayoutIcon`).

- **Router.** Obstacles are `extractGraph` nodes (groups, frames, containers and instances are single boxes; an end inside a group/frame routes among that node's other members). A sparse orthogonal grid is built from obstacle edges ± clearance (20px) and port stubs; A\* costs length + 40 per bend, ×3 inside the clearance band, and ×0.3 on cells already used by an arrow from the same start side, so siblings share a bus. ~0.7s for 300 shapes on the main thread, so the ELK worker isn't used.
- **Sides.** A pinned end (`fixedPoint` on a side, D-DX8; this includes ends Excalidraw mid-snapped) keeps its side. When a shape has 2+ free arrow ends on one role (starts or ends), they all leave from the side facing the other ends' centroid; a free far end that lies wholly beyond gets the opposite side. Otherwise every side is tried.
- **Writes.** `elbowed: true`, `points`, side `fixedPoint` bindings, `fixedSegments` (every interior segment), `startIsSpecial`/`endIsSpecial: false`; the arrow leaves `draft.reroute`. Commit via `commitDraftUndoable` (one undo step; fields that were `undefined` are seeded first so undo can restore them).
- **What Excalidraw re-routes later (0.18.1).** `updateScene` never routes. When a bound shape moves or resizes, `updateElbowArrowPoints` runs for its arrows: with `fixedSegments` it keeps the interior segments and only rebuilds the end legs to the new port; without them it re-routes the whole arrow around just its two bound shapes. Dragging an arrow's segment edits `fixedSegments`; releasing them (or a full re-route) drops the tidy route. Restore drops elbow bindings without a `fixedPoint`, so tidy always writes one.
- **Auto-layout.** After ELK, `tidyAfterLayout` routes the elbows auto-layout pinned along the flow (keeping those sides); any it can't fit stay on Excalidraw's re-route.
- **Layout menu.** `commands.json` (id `excalidraw:layout:<name>`, label, display-only shortcut, separators) is read by `menu.rs` (`include_str!`, top-level Layout menu between Edit and View) and by the toolbar dropdown; `commands.ts` maps ids to `run`s, delegating container commands to `src/layout/containers/commands.ts`. To add a command, append a JSON entry and its `run`.
- No new capability or CSP change. Smoke: `e2e/tidy-arrows.spec.ts`.

### DX wave 2 — Line anchors (face-centre snap)

`src/lib/lineAnchors.ts` (face points, hit-testing, `snapPatches`, `pinnedPatch`, `endAnchors`), `src/extensions/anchors/` (`pointer.ts` drag controller, `rule.ts` reactor rule) and `src/components/lineAnchors/` (snap-dot overlay). Excalidraw 0.18.1 has no endpoint-drag hook, so the controller records a tentative drag on `onPointerDown`, resolves the grabbed end on the first pointermove (from `selectedLinearElement.pointerDownState`), publishes the candidate shapes for the overlay (positioned from scene coordinates), and on `onPointerUp` snaps the released end if it is within 12 screen px of a dot. Elbow ends get the D-DX8 side `fixedPoint`; straight/curved ends get a pin in `customData["excalidrawDesktop.pin"]` (`{start?, end?: {id, anchor}}`) plus an exact point and a binding. The `anchors` rule runs last on the components reactor (`[style, container, component, anchors]`, `apply: "mutate"`, so no collab echo) and puts pinned ends back on their point after any shape change; a pin whose binding moved to another shape is dropped. Cmd/Ctrl (Excalidraw's own bind bypass) skips the snap. Setting `snapArrowAnchors` (default on). Tidy Arrows (D-DX14) treats a pinned straight end as a pinned side and clears the pin when it converts. The Anchors panel section and `set_arrow_anchors` handle both kinds; agent `routeArrow` re-applies pins. Smoke: `e2e/line-anchors.spec.ts`. No new capability or CSP change (D-DX15).

### UX simplification — Pinned sidebar and the AI panel

The AI panel is a flex sibling of the canvas, so opening it narrows the Excalidraw editor. Excalidraw 0.18.1 docks its sidebar only while the editor is wider than `UIOptions.dockedSidebarBreakpoint` (default 1229px); below that the sidebar is an overlay that closes on any outside click, which dropped a pinned Library on a 1440px window. `ExcalidrawCanvas` passes `dockedSidebarBreakpoint: 760` (`src/components/sidebar/sidebarRestore.ts`); a 760px editor still fits the 302px sidebar and a usable canvas. For narrower windows, `installSidebarRestore` remembers a docked sidebar that closed while the AI panel was open and the editor was below the breakpoint, and reopens it (same tab) when the panel closes. Our own tabs live in Excalidraw's `DefaultSidebar`, so they get the same behaviour. Smoke: `e2e/sidebar-ai.spec.ts` (D-DX16). No capability or CSP change.

### UX wave — Panel strip

Every `PanelSection` (`panel.ts`) now has `title`, `icon`, `summary(view)` and an optional `primary(view)` (label, title, disabled, `run(api)`), and `Component` is optional (a body-less row is just a summary and/or an action). `slot: "top"` sections render as strip rows (`StripRow` in `controls.tsx`): each keeps its own host node, inserted at the very start of `.panelColumn` (before Excalidraw's stroke slot), so e2e can still address `.panelColumn > [data-testid=<id>-native]`. The last row gets `props-strip__row--last` (a divider before the native controls). `slot: "bottom"` still appends a plain section after the native controls; no section uses it now. Single-open state: `src/stores/panelStripStore.ts`, persisted as the `panelStripOpen` setting (section id or null). Order (`sections.ts`): component (with its properties) → image → anchors ("Connection") → container ("Stack") → style → data. Test ids `<testId>-toggle` and `<testId>-primary`; e2e opens rows with `e2e/fixtures/strip.ts`. Smoke: `e2e/panel-strip.spec.ts`. No new capability or CSP change (D-DX17).

### UX wave — Concept demotions

Progressive disclosure for the strip (FR-65, D-DX19). A `PanelSection` may add `inUse(view)` and `more(view)`; `stripLayout` (`panel.ts`) hides a section whose `inUse` is false and lists its `more` entry (label, title, optional `run(api)`) in a **"+"** row (`StripMore` in `controls.tsx`, its own host node `props-strip-more-native`, after the last strip row and carrying the last-row divider; docked too). Picking an entry runs `run`, or reveals the row for the current selection (`selectionKey`, reset when the selection changes) and opens it. Style gates on a linked style / overrides / styled master ("Apply style"), Data on having data ("Add data"), Stack on not being in make mode ("Make stack" runs `makeContainerFromSelection`). The Styles sidebar tab (`StylesPanel`) is gone; the Style row gained Rename and Delete style. Containers read "Stack" in panel, Layout menu and toasts (`commands.json`, `layout/containers/commands.ts`; ids unchanged; engine `ToolError` messages still say "container"). Anchors is titled "Connection". The Properties section folded into the Component row (`componentsUi/ComponentRow.tsx`; `propsView` unchanged). Test ids: `props-strip-more-toggle`, `props-strip-more-<testId>`; e2e reveals rows with `revealStripRow` in `e2e/fixtures/strip.ts`. No new capability or CSP change.

### UX wave — Master editor overlay

Edit master… (FR-66, D-DX20) mounts `MasterEditorHost` (`componentsUi/MasterEditor.tsx`) as a sibling of the editor in `.canvas-slot`: a second `<Excalidraw>` (`autoFocus`, `onDuplicate` and `onPointerUpdate` forwarded, no file actions) under an accent header. `masterEditScene.ts` builds its scene from `masterSnapshot`: the master aligned on the opened instance (same largest slot when the size and angle match, else centred), plus dimmed, locked copies of the drawing within one viewport around it (fresh ids, bindings cut, `customData` ctx mark). Done flushes the overlay reactor, strips the context, shifts the master back and calls `applyComponentMasterEdit` (one undo step, one collab update); an unchanged edit closes without one. `masterEditStore.ts` keeps one session per window; closing restores an undocked main sidebar and hands focus back to the drawing. The on-canvas edit path (`MasterEditBanner`, Go to master, Move to My components) is gone from the UI; agent tools keep `materializeMaster`. Test ids: `master-edit`, `master-edit-header`, `master-edit-done`, `master-edit-cancel`, `master-edit-update-library`; e2e reaches the overlay API as `window.__masterEditor`. No new capability or CSP change.

## 7. Decisions log

| #      | Decision                                                                                                                                                                                                                                                                            | Why                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1     | Embed `@excalidraw/excalidraw` React component                                                                                                                                                                                                                                      | Self-contained npm package, no server needed, easy upstream bumps.                                                                                     |
| D2     | Tauri 2.x                                                                                                                                                                                                                                                                           | Current stable; better plugin ecosystem; first-class file associations.                                                                                |
| D3     | JSON + PNG-with-scene formats                                                                                                                                                                                                                                                       | Covers the common roundtrip; PNG shareable while still editable.                                                                                       |
| D4     | Single window with tabs                                                                                                                                                                                                                                                             | Matches user expectation; simpler state than multi-window.                                                                                             |
| D5     | Recent files + autosave + session restore                                                                                                                                                                                                                                           | Standard native-app expectation.                                                                                                                       |
| D-C1   | Collab via embedded Rust relay + DevTunnels, not Firebase                                                                                                                                                                                                                           | Firebase is persistence only; relay needed anyway. No third-party account, E2E encrypted, data stays on host.                                          |
| D-C2   | Own tiny JSON relay protocol (not socket.io)                                                                                                                                                                                                                                        | Trivial to implement in Rust and on Cloudflare DO later; no socket.io client dep.                                                                      |
| D-R1   | Notarize locally, Windows in CI                                                                                                                                                                                                                                                     | Apple credentials stay in the local keychain; no secrets in GitHub.                                                                                    |
| D-C3   | Static CSP allow-list incl. loopback + `*.devtunnels.ms`                                                                                                                                                                                                                            | Runtime CSP widening needs a reload in Tauri 2; origins are inert unless a session starts (gated by setting).                                          |
| D6     | npm + Vite + React + TS                                                                                                                                                                                                                                                             | User preference; React is required by Excalidraw.                                                                                                      |
| D7     | Vitest + cargo test + Playwright via tauri-driver                                                                                                                                                                                                                                   | Layered coverage from units to full app smoke.                                                                                                         |
| D8     | Online features opt-in via settings, off by default                                                                                                                                                                                                                                 | User wants the capability but no data leaving the box by default.                                                                                      |
| D9     | Signing/notarization documented, deferred                                                                                                                                                                                                                                           | User asked for docs without implementation in v1.                                                                                                      |
| D-U1   | Auto-update asks once on first launch; never auto-restart                                                                                                                                                                                                                           | Keeps the offline-first promise explicit; user decides when to restart (unsaved work, live sessions).                                                  |
| D-U2   | Updater runs in Rust, frontend owns the schedule                                                                                                                                                                                                                                    | No CSP/capability change; consent lives in one setting; Rust never checks on its own.                                                                  |
| D-U3   | Updater key local + GitHub secrets; signed versions                                                                                                                                                                                                                                 | Mac artifacts signed locally like notarization; Windows in CI; `requireSignedVersion` blocks downgrades.                                               |
| D-AI1  | Copilot CLI + Claude Code + Codex in v1 behind one `EngineAdapter` trait and one canonical event model                                                                                                                                                                              | Users bring whichever subscription they already have; adding an engine means adding one adapter.                                                       |
| D-AI2  | Docked per-tab chat panel                                                                                                                                                                                                                                                           | Conversations relate to a specific diagram; the panel leaves the canvas visible while editing.                                                         |
| D-AI3  | Live-apply, one undo step per turn, plus Revert turn                                                                                                                                                                                                                                | Fast feedback; standard undo still works; collab-safe revert.                                                                                          |
| D-AI4  | Session or attached working folder; in-folder writes auto-approved; shell gated; opt-in per-conversation "Allow all" in our handler, never engine bypass modes                                                                                                                      | Agent can produce files; blast radius stays one folder; the user can skip repeated cards knowingly.                                                    |
| D-AI5  | Per-engine "Use my MCPs, skills & plugins" (default on) with in-app approvals                                                                                                                                                                                                       | Users keep their agent's power; tools that act outside the canvas still need consent.                                                                  |
| D-AI6  | Claude Code as bring-your-own-binary: if it is installed and signed in, use it; never touch credentials                                                                                                                                                                             | Matches prior art (T3 Code). Anthropic's terms are ambiguous for wrappers, so legal review is a release gate.                                          |
| D-AI7  | No API keys; remove `openAiKey`                                                                                                                                                                                                                                                     | The key was never used; storing it in plaintext violated SEC-3.                                                                                        |
| D-AI8  | Canvas tools served via a loopback MCP server + stdio shim instead of engine-specific tool APIs                                                                                                                                                                                     | One tool implementation works for every engine and transport.                                                                                          |
| D-AI9  | Port concepts, schemas and test tooling from T3 Code (MIT) into our Rust core; don't embed its Node server or Tailwind UI                                                                                                                                                           | It already drives Copilot ACP, Claude and Codex app-server. A Node sidecar would add a bundled runtime and a second process model.                     |
| D-X1   | Desktop extensions store intent in `customData` and always write standard output; built-in only                                                                                                                                                                                     | Adds features without forking Excalidraw or changing the file format; files still render everywhere; no third-party code loading.                      |
| D-X2   | Image extensions stack: ordered chain per element (stage, then id), one original + one output, re-rendered from the original on every change                                                                                                                                        | Decorations (Border) must follow the current shape; re-rendering from the original avoids compounding loss and keeps one undo step.                    |
| D-X3   | Image controls are portaled into Excalidraw's properties panel (`.panelColumn`), falling back to a docked island; image border mirrors native stroke (picker, width, style, roughjs sloppiness)                                                                                     | 0.18.1 has no panel API; a floating strip was unwieldy. The DOM contract is guarded by e2e, and no fork or patch is needed.                            |
| D-L1   | Auto-layout: bundled elkjs (EPL-2.0) in a lazy, same-origin worker; one `Draft` commit; UI = top-level Layout menu + toolbar Layout dropdown + Alt/Option+Shift+L                                                                                                                   | ELK layered + tree; worker needs no `eval` (CSP unchanged). Elbows: ends pinned along the flow, then routed around shapes by the tidy router (D-DX14). |
| D-DX1  | Derived sync "reactor": `onChange` version diffs, then `updateScene(NEVER)` in place via `mutateElement`; collab applies tagged by wrapping the `CollabSession` api (docs/reactor-spike.md)                                                                                         | Spike: one undo step per edit, no redo loss, no collab echo; in-place apply keeps rough.js shapes: 990 targets drag at ~10 ms p95.                     |
| D-X4   | Image effects are chain stages: colour (50) before mask, shadow (300) after border; bounds grow via `plan.pad`/`source.inset`                                                                                                                                                       | Image stays put; v2 ids unchanged; manual pixel maths (WKWebView lacks `ctx.filter`).                                                                  |
| D-DX2  | Shape data and other new desktop features use sibling `customData` keys (`excalidrawDesktop.data` = versioned key/value pairs); image stack v2 is untouched; newer data is read-only; layer names in `excalidrawDesktop.layer` (frames keep their native `name`)                    |
| D-DX4  | UI surfaces: extra sidebar tabs through one `SidebarTabs` host (`DefaultSidebar.TabTriggers` / `Sidebar.Tab`); one properties-panel host (`PropertiesPanelHost`) for any selection, portaling registered sections into `.panelColumn` or a docked island and bridging Ctrl/Cmd keys |
| D-DX7  | Personal library persisted to app data per profile; guests never write                                                                                                                                                                                                              | Fixes the library being lost between launches without network or new capabilities.                                                                     |
| D-DX8  | Elbow-arrow anchors pin bound ends with Excalidraw's own `fixedPoint` bindings (n/e/s/w; "center" = side facing the other end when set) and let its router re-route                                                                                                                 | 0.18.1 binds elbows by fixedPoint natively; no custom routing. Lines can't bind, so they're out of scope.                                              |
| D-DX9  | Components v1: master + live instances on the reactor (in-place apply, collab tagged remote); `excalidrawDesktop.component` v1 (role, componentId, slot, gi, base, overrides); orphans: smallest-group instance promoted; master copies become instances                            | One undo step per edit; deterministic across peers; see `docs/components.md`                                                                           |
| D-DX12 | Named styles: definitions denormalized onto linked elements (`excalidrawDesktop.style` v1: id, name, rev, props, overrides); highest `rev` wins; a style lives while an element uses it. Styles rule runs **before** components on one reactor, which chains rule writes in a flush | One undo step; style edits reach instances as master changes, not overrides; instance children are never members; see `docs/styles.md`                 |
| D-DX10 | Components UI: My components is a separate app-data store (not Excalidraw's library) so entries can carry image `BinaryFiles`; library inserts place a `source:"library"` instance; editing is materialize → Done (save + dematerialize) / Cancel                                   | Excalidraw 0.18's library rejects images; masters stay off the canvas; one undo step per action                                                        |
| D-DX13 | Smart containers: a group + tagged background rectangle (`excalidrawDesktop.layout` v1: direction, gap, padding, align, justify, sizing, gi) re-flowed by a key-level reactor rule; rule order `[style, container, component]`; gestures hold their elements until release          | Groups nest and work in masters and auto-layout, unlike frames; one undo step per edit; see `docs/containers.md`                                       |
| D-DX14 | Tidy Arrows: own orthogonal router (`src/layout/route.ts`: sparse grid from obstacle edges ± clearance, A\* with bend penalty and trunk discount; no ELK, no new dependency) writes elbow `points` + `fixedSegments` + side `fixedPoint`s as one `Draft` commit                     | Excalidraw 0.18.1 routes elbows only around their own two shapes; `fixedSegments` keep the route when a bound shape moves (only end legs rebuilt)      |
| D-DX15 | Line anchors: straight/curved ends pinned to a face midpoint or centre via `customData` pin + last reactor rule (`mutate`); elbows reuse D-DX8 `fixedPoint`; snap on pointer-up                                                                                                     | No endpoint-drag hook in 0.18.1; pointer + appState detection; one undo step, no echo                                                                  |
| D-DX16 | Pinned sidebar vs AI panel: `UIOptions.dockedSidebarBreakpoint` 760, plus reopen a docked sidebar that closed as an overlay while the AI panel was open, when the panel closes                                                                                                      | Default 1229px breakpoint turned a pinned sidebar into an overlay on a 1440px window with the 360px AI panel                                           |
| D-DX11 | Component properties are typed (`text`, `color`, `boolean`, `choice`) with slot bindings; values are overrides with precedence `npv` ← `pv` ← explicit. Nesting stores one tag per component (`v: 2`) and syncs inner to outer                                                      | Instance edits stay overrides, defaults follow the master; v1 files still read; one undo step; see `docs/components.md` §4b–4c                         |
| D-DX17 | Our panel sections are a strip of compact rows (icon, title, summary, optional inline primary) at the top of `.panelColumn`; single-open accordion, open row persisted in settings; each row keeps its own host node                                                                | Sections no longer sit below the native controls (no scrolling); rows stay addressable; L4 can add rows/overflow                                       |
| D-DX18 | Masterless components: create makes the first instance; the master lives off-canvas (rebuilt for edits by `withMaster`/`applyMasterEdit`); legacy masters demoted on load                                                                                                           | No master to trip over (FR-64); one undo step, no collab echo; see `docs/components.md` §4a                                                            |
| D-DX19 | Demote rare concepts: Style/Data/Stack rows only when the selection uses them, else a "+" strip row; no Styles tab; "Stack" in UI for containers; Anchors → "Connection"; Properties inside Component                                                                               | Fewer concepts up front without cutting features; engines, agent tools and command ids unchanged                                                       |
| D-DX20 | Master edits happen in a temporary overlay canvas (second `<Excalidraw>`) with dimmed, locked context copies, not on the drawing or a live transparent overlay                                                                                                                      | Matches Sketch; the drawing never holds a master (FR-66); one undo, no collab traffic until Done                                                       |
| D-DX22 | Sidebar tab memory: `appState.openSidebar.tab` (via `api.onChange`) persisted as the `sidebarTab` setting; our own `DefaultSidebar.Trigger` replaces the fallback Library button with `tab` = the remembered one                                                                    | Public trigger tunnel; no post-open tab switch, so explicit opens (e.g. `openLibraryMenu`) keep their tab                                              |

## 8. Risks & mitigations

| Risk                                                                              | Mitigation                                                                                                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@excalidraw/excalidraw` API changes between minor versions                       | Pin exact version; bump via `/bump-excalidraw` skill which runs smoke tests.                              |
| Windows file association requires deep-link plumbing + single-instance            | Use both plugins together; covered by Playwright smoke test for double-click.                             |
| PNG-with-scene metadata fragile (stripped by some tools)                          | Keep `.excalidraw` JSON as authoritative; PNG is a sharing convenience only.                              |
| Tauri webview differences (WKWebView vs WebView2) cause Excalidraw rendering bugs | Run vitest + playwright on both runners in CI before tagging a release.                                   |
| User enables collab/AI then leaks data unintentionally                            | Toggles default off; warning copy in settings; CSP only widened when enabled.                             |
| Agent protocols are preview/experimental (Copilot ACP, Codex app-server)          | Pin minimum versions, probe capabilities at detect time, fixture tests per adapter, generic-ACP fallback. |
| Subscription terms for third-party use (esp. Claude)                              | BYO binary only, never read credentials, terms note in Settings, legal review as AI-6 gate.               |
| User MCPs/plugins act outside the canvas                                          | Per-engine toggle, approval cards, engine shell/write always disabled.                                    |
| Agent quota/cost surprises                                                        | Panel footer states which plan/quota is used; per-turn usage shown when the engine reports it.            |

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
