# Excalidraw Desktop — Requirements

> A native desktop wrapper around the official Excalidraw editor that runs **fully offline**, reads and writes files **directly from the local filesystem**, and feels like a first-class macOS and Windows app.

---

## 1. Goals

1. Provide a Mac (`.app` / `.dmg`) and Windows (`.exe` / `.msi`) desktop application that lets the user edit Excalidraw diagrams locally.
2. **No diagram data leaves the device** unless the user explicitly opts in to an online feature.
3. Use the **official upstream Excalidraw editor** (the `@excalidraw/excalidraw` React component) so we inherit upstream bug fixes and feature improvements for free.
4. Behave like a native app — file associations, double-click opens, standard menu bar, keyboard shortcuts, recent files, autosave.

## 2. Non-Goals

- Hosted/always-on collaboration backend in v1. Live sessions are served by a relay embedded in the host's desktop app and exposed through a tunnel (DevTunnels); a cloud relay is a documented future option.
- Cloud sync. The user's filesystem is the source of truth.
- Mobile/Linux distribution in v1 (Linux build should remain technically possible via Tauri but is not a release target).
- Rewriting or forking Excalidraw.

## 3. Platforms

| Platform | Minimum version | Bundles                  |
| -------- | --------------- | ------------------------ |
| macOS    | 11 Big Sur      | Universal `.app`, `.dmg` |
| Windows  | 10 64-bit       | `.msi` and `.exe` (NSIS) |

## 4. Functional Requirements

### 4.1 Excalidraw integration

- **FR-1** The editor canvas MUST be the official `@excalidraw/excalidraw` React component, embedded in our Vite/React frontend and loaded by the Tauri webview.
- **FR-2** The app MUST run with no network access required at any point in normal use (open / edit / save / export).
- **FR-3** Upstream Excalidraw bumps MUST be possible with a single dependency update + smoke test pass.

### 4.2 File handling

- **FR-4** Supported file formats:
  - `.excalidraw` (JSON, Excalidraw's native format) — read + write.
  - `.png` with embedded Excalidraw scene — write (export) and read (re-open as editable).
- **FR-5** The app MUST register itself as the OS handler for `.excalidraw` files on macOS and Windows so double-click opens the file in the app.
- **FR-6** Drag-and-drop of supported files onto the app window or dock/taskbar icon MUST open them.
- **FR-7** A second invocation of the app (e.g., double-clicking a file while the app is running) MUST route the file to the already-running instance and open it in a new tab — not spawn a second process.

### 4.3 Multi-document UI

- **FR-8** A single window MUST support multiple open documents as **tabs**.
- **FR-9** Each tab tracks its own file path, dirty state, and undo history.
- **FR-10** Closing a tab with unsaved changes MUST prompt to save / discard / cancel.

### 4.4 Persistence

- **FR-11** The app MUST maintain a **Recent Files** list (last 20), persisted across launches, exposed under `File → Open Recent`.
- **FR-12** The app MUST **autosave** dirty tabs:
  - Before first explicit save: to a scratch location under the app's data dir, restored on next launch.
  - After first save: debounced (default 2s of idle) writes to the user's chosen file path.
  - Writing to the file path is controlled by the **Autosave** setting (Settings → Saving, default on). When it is off, file-backed tabs are backed up to scratch instead, stay dirty, and the file only changes on an explicit Save; the backup is restored (still unsaved) on next launch and discarded on Save or Close.
- **FR-13** On launch, the app MUST **restore the previous session**: re-open the tabs that were open at quit, and select the previously active tab.

### 4.5 Native menus & shortcuts

- **FR-14** macOS and Windows MUST have a standard menu bar:
  - **File**: New Tab, Open…, Open Recent ▶, Save, Save As…, Export as PNG…, Close Tab, Quit
  - **Edit**: Undo, Redo, Cut, Copy, Paste, Select All (forwarded to Excalidraw)
  - **View**: Zoom In, Zoom Out, Reset Zoom, Toggle Theme (light/dark/system), Toggle Sidebar
  - **Window** (macOS): Minimize, Zoom, Bring All to Front, plus per-tab entries
  - **Help**: About, Open Logs Folder, Project Website
- **FR-15** Platform-standard shortcuts MUST work: `⌘/Ctrl+N`, `⌘/Ctrl+O`, `⌘/Ctrl+S`, `⌘/Ctrl+Shift+S`, `⌘/Ctrl+W`, `⌘/Ctrl+Q` (mac), `⌘/Ctrl+T`, `⌘/Ctrl+Shift+T`.

### 4.6 Settings & opt-in online features

- **FR-16** A Settings window/dialog MUST expose toggles for:
  - **Real-time collaboration** — default **off**. See §4.8.
  - **Library browser** (`libraries.excalidraw.com`) — default **off**. When enabled, the app opens the library page in the system browser.
  - **AI agent** — default **off**. Drives the user's own locally installed, signed-in agent (GitHub Copilot CLI, Claude Code, or OpenAI Codex). No API keys. See §4.9.
- **FR-17** Toggles MUST persist across launches and survive app updates.
- **FR-18** With all toggles off, the app MUST make zero outbound network requests during normal use (verified by Playwright + a network blocker in CI smoke tests). The only exception is the update check (FR-20), which runs only after the user opts in or explicitly clicks "Check for Updates…".

### 4.7 Updates & telemetry

- **FR-19** No telemetry. No analytics. No crash-reporter that phones home in v1.
- **FR-20** Auto-update (M12) for macOS (universal) and Windows via `tauri-plugin-updater` against a signed `latest.json` on GitHub Releases:
  - **Consent:** on first launch of an installed build, the app asks once whether to check for updates automatically and remembers the answer (`autoUpdate` setting; `null` = not asked). Settings → Updates has the toggle, the current version, and "Check now". "Check for Updates…" (macOS app menu / Windows Help menu) always works.
  - **Behavior:** with consent, checks ~20 s after launch and every 6 h; downloads and signature-verifies in the background, then shows "Restart to update / Later". The app never restarts on its own. Pending autosaves are flushed before restarting.
  - **Privacy:** the request sends only the app version / platform (no diagram data) and is made natively from Rust, not from the webview. Dev builds never check.
  - **Integrity:** every artifact is minisign-signed with the updater key; `requireSignedVersion` binds the signature to the version so a downgrade can't be replayed. Only published (non-draft) releases are served.

### 4.8 Live collaboration (M10)

Protocol & component contract: `docs/collab-protocol.md`.

- **FR-21** With collaboration enabled, the user can **Start session** on the active tab. The app runs a local relay (127.0.0.1 only) and produces a share link `<publicBase>/#room=<id>,<key>`.
- **FR-22** Public reachability via **DevTunnels**: _auto_ (the app drives the `devtunnel` CLI: persistent tunnel, anonymous access), _manual_ (user supplies a public URL, e.g. from Tunnel Bar, forwarding to the configured port), or _local_ (127.0.0.1 only).
- **FR-23** Guests join from a **plain browser** (no install) — the relay serves the app bundle, which runs in guest mode. A second desktop app can join via **Join session…**.
- **FR-24** Full co-editing: concurrent edits merge via Excalidraw's `reconcileElements`; live cursors with names, selections, collaborator avatars; images sync.
- **FR-25** All session content is **end-to-end encrypted** (AES-GCM, key only in URL fragment). The relay and tunnel see ciphertext only. Relay accepts only host-registered rooms.
- **FR-26** The host's file on disk remains the source of truth; remote edits mark the tab dirty and save through the normal path. Stopping the session disconnects everyone (close 4000) and tears down the tunnel.

### 4.9 AI agent — bring your own engine (AI-0…AI-6)

Design contract: `docs/ai-integration.md`. Manual validation: `docs/ai-testing.md`.

- **FR-27** With the AI toggle on, Settings → AI MUST detect GitHub Copilot CLI, Claude Code, and OpenAI Codex. Detection covers GUI-launch PATH issues and Windows `.cmd` shims. For each engine it shows path, version, and signed-in state, and lets the user override the binary path and enable/disable the engine.
- **FR-28** The app MUST use the engine's **existing local sign-in**. It MUST NOT ask for, read, store, or proxy API keys, OAuth tokens, or other AI credentials. When an engine is not signed in, the app shows that engine's own sign-in command.
- **FR-29** A docked, resizable **agent panel** MUST provide one conversation per tab, with streaming responses, tool-activity chips, Stop, and a selectable engine and model.
- **FR-30** The agent reads and edits the canvas only through tools the app serves over a loopback, token-authenticated MCP server: summary, selection, rendered PNG, add/update/delete/connect, Mermaid import, arrange, and viewport. Each agent turn MUST be applied live as **one undoable step**. Each turn MUST offer **Revert turn**. Agent edits sync to collaborators like local edits and are refused in collab viewer tabs.
- **FR-31** The agent works in a per-conversation **session folder** by default, or in a folder the user **attaches**. File writes inside that working folder are auto-approved; shell commands MUST need in-app approval (or run only inside the engine's no-network sandbox), and writes outside MUST be blocked or approved. No blanket file access. A folder can be attached after the conversation starts only if none was set; it can never be changed or detached afterwards. The Folder row shows the session folder with Reveal.
- **FR-32** A per-engine setting **"Use my agent's MCPs, skills & plugins"** (default on) loads the user's own harness configuration. Any permission request for a tool that isn't one of our canvas tools and isn't known to be read-only MUST show an in-app approval card: Allow once / Allow for this conversation / Deny.
- **FR-33** The first use of each engine MUST show a disclosure of what is sent to which provider under the user's account. Network traffic for AI comes only from the user's agent process, after the toggle is on and the user sends a prompt.
- **FR-34** Excalidraw's built-in "Text to diagram" dialog MUST be backed by the default engine when AI is enabled.

### 4.10 Desktop extensions

- **FR-35** Features beyond Excalidraw's schema MUST be built as built-in extensions (`docs/extensions.md`) that store intent in `element.customData` and always write standard elements and files, so documents render identically in stock Excalidraw, exports and collab. No third-party or document-supplied code is ever loaded.
- **FR-36** Each extension is defined once and exposed both in the UI (a selection-aware bar) and to the agent (`apply_extension` / `remove_extension`). Applying to several elements is one undo step; collab peers receive it as a normal edit.
- **FR-37** Remove and re-apply MUST derive from the stored source. If the element was changed elsewhere so its output no longer matches the intent, it is treated as not applied and left alone. Source files an intent depends on MUST survive save, reload and collab sync.
- **FR-38** First extension: **Mask** for images — Circle, Rounded rectangle, Remove mask.

## 5. Non-Functional Requirements

- **NFR-1** Cold launch under 2 seconds on a 2020-class machine.
- **NFR-2** Open / save round-trip for a 5 MB `.excalidraw` file in under 500 ms.
- **NFR-3** Installable app bundle under 30 MB per platform (Tauri keeps this realistic; Electron would not).
- **NFR-4** All Rust code MUST pass `cargo clippy -- -D warnings`.
- **NFR-5** All TypeScript MUST pass `tsc --noEmit` and `eslint` with no errors.
- **NFR-6** Unit-test coverage MUST exist for: file format detection, recent-files store, settings store, tab manager, and every Tauri command (Rust side).

## 6. Security & Privacy

- **SEC-1** Tauri allowlist MUST be minimal: only `fs` (scoped), `dialog`, `path`, `os`, `store`, `single-instance`, `deep-link`, `opener`.
- **SEC-2** Filesystem scope MUST default to user-selected files; no broad read of `$HOME`.
- **SEC-3** Secrets MUST be stored via OS keychain (`tauri-plugin-keyring` or `tauri-plugin-stronghold`), never in plaintext config files. The app stores **no AI credentials at all** (FR-28). The legacy `openAiKey` setting is removed and scrubbed from `settings.json` on migration.
- **SEC-6** Agent engines are spawned only from Rust, with fixed argument builders that always sandbox the engine: writes scoped to the working folder(s), shell behind approval or the no-network sandbox, never allow-all. The webview gets no shell or process capability. The MCP server binds 127.0.0.1 only and requires a per-session random token. Child process trees are killed on tab close and on quit.
- **SEC-4** Webview CSP MUST forbid remote scripts unless an online feature is explicitly enabled.
- **SEC-5** Distribution builds MUST be signed and notarized (see `docs/plan.md` §"Signing & Notarization" — documented, deferred for v1 implementation).

## 7. Distribution (deferred for v1 implementation, documented in plan)

- macOS Developer ID Application certificate, hardened runtime, `notarytool` notarization, stapled `.dmg`.
- Windows Authenticode (EV or OV) certificate via `signtool`, or Azure Trusted Signing.
- GitHub Actions release workflow described but not committed in v1.

## 8. Out of Scope (v1)

- Linux builds as a release target.
- Telemetry / analytics.
- Custom Excalidraw extensions beyond what the upstream component exposes.
- Mobile (iOS/iPadOS/Android).
- Cloud sync / file watchers / multi-device.

## 9. Open Questions

_None currently — captured decisions are in `docs/plan.md` § "Decisions Log"._
