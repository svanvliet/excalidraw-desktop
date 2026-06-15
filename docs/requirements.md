# Excalidraw Desktop — Requirements

> A native desktop wrapper around the official Excalidraw editor that runs **fully offline**, reads and writes files **directly from the local filesystem**, and feels like a first-class macOS and Windows app.

---

## 1. Goals

1. Provide a Mac (`.app` / `.dmg`) and Windows (`.exe` / `.msi`) desktop application that lets the user edit Excalidraw diagrams locally.
2. **No diagram data leaves the device** unless the user explicitly opts in to an online feature.
3. Use the **official upstream Excalidraw editor** (the `@excalidraw/excalidraw` React component) so we inherit upstream bug fixes and feature improvements for free.
4. Behave like a native app — file associations, double-click opens, standard menu bar, keyboard shortcuts, recent files, autosave.

## 2. Non-Goals

- Real-time collaboration backend (we expose only an opt-in toggle to the upstream UI; we do not host a server).
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
  - **Real-time collaboration** (Firebase) — default **off**. When enabled, the user must supply their own Firebase config.
  - **Library browser** (`libraries.excalidraw.com`) — default **off**. When enabled, the app opens the library page in the system browser.
  - **AI text-to-diagram** (OpenAI) — default **off**. When enabled, the user supplies their own API key, stored in the OS keychain.
- **FR-17** Toggles MUST persist across launches and survive app updates.
- **FR-18** With all toggles off, the app MUST make zero outbound network requests during normal use (verified by Playwright + a network blocker in CI smoke tests).

### 4.7 Updates & telemetry

- **FR-19** No telemetry. No analytics. No crash-reporter that phones home in v1.
- **FR-20** Auto-update is **out of scope for v1** (manually download new releases). Wired-up update plumbing is fine if disabled.

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
- **SEC-3** Secrets (Firebase config, OpenAI API key) MUST be stored via OS keychain (`tauri-plugin-keyring` or `tauri-plugin-stronghold`), never in plaintext config files.
- **SEC-4** Webview CSP MUST forbid remote scripts unless an online feature is explicitly enabled.
- **SEC-5** Distribution builds MUST be signed and notarized (see `docs/plan.md` §"Signing & Notarization" — documented, deferred for v1 implementation).

## 7. Distribution (deferred for v1 implementation, documented in plan)

- macOS Developer ID Application certificate, hardened runtime, `notarytool` notarization, stapled `.dmg`.
- Windows Authenticode (EV or OV) certificate via `signtool`, or Azure Trusted Signing.
- GitHub Actions release workflow described but not committed in v1.

## 8. Out of Scope (v1)

- Linux builds as a release target.
- Auto-update.
- Telemetry / analytics.
- Custom Excalidraw extensions beyond what the upstream component exposes.
- Mobile (iOS/iPadOS/Android).
- Cloud sync / file watchers / multi-device.

## 9. Open Questions

_None currently — captured decisions are in `docs/plan.md` § "Decisions Log"._
