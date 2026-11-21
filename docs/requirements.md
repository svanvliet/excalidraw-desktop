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
- **FR-31** The agent works in a per-conversation **session folder** by default, or in a folder the user **attaches**. File writes inside that working folder are auto-approved; shell commands MUST need in-app approval (or run only inside the engine's no-network sandbox), and writes outside MUST be blocked or approved. No blanket file access. The user MAY choose **Allow all for this conversation** on an approval card: every later permission request in that conversation is then approved without a card until they Turn it off from the Approvals indicator; it is never persisted and resets with each engine session. A folder can be attached after the conversation starts only if none was set; it can never be changed or detached afterwards. The Folder row shows the session folder with Reveal.
- **FR-32** A per-engine setting **"Use my agent's MCPs, skills & plugins"** (default on) loads the user's own harness configuration. Any permission request for a tool that isn't one of our canvas tools and isn't known to be read-only MUST show an in-app approval card: Allow once / Allow for this conversation / Allow all for this conversation / Deny.
- **FR-33** The first use of each engine MUST show a disclosure of what is sent to which provider under the user's account. Network traffic for AI comes only from the user's agent process, after the toggle is on and the user sends a prompt.
- **FR-34** Excalidraw's built-in "Text to diagram" dialog MUST be backed by the default engine when AI is enabled.

### 4.10 Desktop extensions

- **FR-35** Features beyond Excalidraw's schema MUST be built as built-in extensions (`docs/extensions.md`) that store intent in `element.customData` and always write standard elements and files, so documents render identically in stock Excalidraw, exports and collab. No third-party or document-supplied code is ever loaded.
- **FR-36** Each extension is defined once and exposed both in the UI (sections in Excalidraw's properties panel for the selection) and to the agent (`apply_extension` / `remove_extension`). Applying to several elements is one undo step; collab peers receive it as a normal edit.
- **FR-37** Remove and re-apply MUST derive from the stored source. Image extensions stack in a canonical order (shapes before decorations) on one recorded original; changing any one re-renders the whole chain, and removing the last restores the original. Older single-extension documents MUST keep working. If the element was changed elsewhere so its output no longer matches the intent, it is treated as not applied and left alone. Source files an intent depends on MUST survive save, reload and collab sync.
- **FR-38** First extension: **Mask** for images — No mask, Circle, Rounded rectangle.
- **FR-39** **Border** for images, with the same treatment as native shape strokes: a colour picker matching the native one (top picks, palette, shades, hex; transparent removes the border), stroke width (thin / bold / extra bold), stroke style (solid / dashed / dotted) and sloppiness (architect / artist / cartoonist). Drawn inside the current outline (the mask shape when masked), so bounds never change; dashes and sloppiness follow that outline and re-render identically. Works with or without a mask; older borders keep loading.
- **FR-40** Image controls MUST appear in Excalidraw's own properties panel when images are selected (including the mobile properties sheet), and fall back to a compact docked panel when that panel isn't available — never a long floating strip. Each change is one undo step and keyboard focus stays on the canvas.
- **FR-41** Image **effects**, stacked with Mask and Border on the same original: **Grayscale** (amount 0–100 %), **Tint** (colour plus strength) and **Shadow** (offset, blur, colour, opacity). Colour effects run before the mask and never recolour the border; the shadow follows the final shape and is drawn outside the image without moving it (the element's bounds grow to include it). Rendering MUST be deterministic and MUST NOT rely on `ctx.filter` (unsupported in WKWebView). Each apply or remove is one undo step, including after a slider change, and older chain v2 documents keep loading.

### 4.11 Auto-layout (Wave 1)

> Lane-scoped ids (`FR-LAYOUT-n`) so parallel lanes don't collide; renumber on merge if needed.

- **FR-LAYOUT-1** A one-shot **Auto-layout** action MUST lay out the current selection, or the whole diagram when nothing is selected, as a **layered** graph (top-to-bottom or left-to-right) or a **tree**. Entry points: **Layout ▸ Top to Bottom / Left to Right / Tree** in the native top-level Layout menu, the same commands in the toolbar's **Layout** dropdown, and **Alt/Option+Shift+L** (top-to-bottom) in the editor. Elbow arrows it pins along the flow are then routed around other shapes as in FR-60.
- **FR-LAYOUT-2** Arrows bound at both ends are the graph's edges. Groups and frames (with their children) move as single nodes; text bound to a container moves with it. Arrows are re-routed afterwards so every binding stays valid, and arrows from outside the laid-out set to moved shapes follow.
- **FR-LAYOUT-3** The whole layout is **one undo step** (for the agent: part of the turn's single undo step). If the user edits the canvas while the layout is computing, the result is discarded rather than overwriting the edit.
- **FR-LAYOUT-4** The layout engine (ELK) MUST be bundled and run in a **web worker** loaded from the app's own origin, offline, under the shipped CSP (no `unsafe-eval`; `worker-src 'self' blob:`). It is loaded lazily on first use.
- **FR-LAYOUT-5** The agent gets the same capability as an `auto_layout` canvas tool (algorithm, direction, spacing, optional ids) that also works inside `apply_ops`.

### 4.12 Library & layers

- **FR-49** The personal Excalidraw library ("My library") MUST persist across launches in app data (`library.json`, or `library-<profile>.json` under `--profile`) and load as each editor's initial library. Adds, removes and `.excalidrawlib` imports save immediately and appear in every open tab. Nothing is saved before the stored library has loaded, so a failed or slow load can never wipe it. Live-collab guest tabs and the browser guest app never write to it.
- **FR-50** Excalidraw's own sidebar MUST gain a **Layers** tab, next to Search and Library, that lists the scene as a tree: frames, then groups (outer groups containing inner ones), then elements, topmost first. Clicking a row selects it and scrolls it into view. Each row has a lock toggle (a group locks all its members). Double-click renames: groups and elements store the name in `customData["excalidrawDesktop.layer"]`; frames use their native `name`. Every rename or lock is one undo step and syncs to collab peers. It follows the light/dark theme with Excalidraw's own styling. The agent gets `list_layers` and `update_layer`. Hiding layers is deferred.

### 4.13 Panel host, shape data and anchors (DX wave 1)

- **FR-51** Any selection type MAY add sections to Excalidraw's own properties panel through one shared host (same DOM contract and docked fallback as FR-40). Ctrl/Cmd shortcuts (undo, redo, …) MUST keep reaching the canvas after any panel control is used; a focused text input keeps its own typing and text undo.
- **FR-52** **Shape data**: any element can carry ordered key/value string pairs, edited in a **Data** panel section (add, edit, rename, remove; a mixed selection shows the keys every element shares). Each change is one undo step. Data MUST survive save, reload, PNG round-trip and collab, be readable by the agent (`get_scene_summary`, `get_elements`, `get_shape_data`) and writable by it (`set_shape_data`), and be copyable as CSV. Data written by a newer version is shown read-only. External data sources are out of scope.
- **FR-53** **Elbow-arrow anchors**: each bound end of an elbow arrow can be pinned to the top, right, bottom or left of its shape, or to the side facing the other end, from an **Anchors** panel section or the agent (`connect` with `startAnchor` / `endAnchor`, `set_arrow_anchors`). Excalidraw's router re-routes the arrow; each change is one undo step. Lines (which can't bind) are out of scope.

### 4.14 Components (DX wave 2)

- **FR-54** **Components**: a selection or group can become a component **master** on the canvas; duplicating, pasting or Alt-dragging the master (or `insert_instance`) places **instances** that follow it live: geometry under each instance's own translate / scale / rotation, styles, text (re-measured, never copied) and added or removed children. Each instance can override text, fill/stroke colour, opacity, link and image per child, reset them, or be detached. A master edit and the instance updates it causes are **one undo step**. Deleting the master promotes one instance (undo restores the original). Component data is versioned `customData` (D-DX2) that survives save, reload and collab. The agent gets `create_component`, `insert_instance`, `list_components`, `set_overrides`, `reset_overrides` and `detach_instance`. Alt/Option+Cmd/Ctrl+K creates a component; the UI is FR-55. See `docs/components.md`.
- **FR-55** **Components UI**:
  - A **Components** sidebar tab lists this drawing's masters, the user's personal **My components** library, and Excalidraw library items, all with thumbnails. Click or drag a row to place an instance; library items can become components.
  - My components is cross-document and stored in app data per profile. It supports components with images, storing their files with each entry. Guests can't save, and it exports to `.excalidrawlib` (images dropped, with a warning).
  - Inserting a saved component places a library-backed instance whose master stays in My components. **Edit master…** puts it on the canvas until **Done**, which saves and removes it, or **Cancel**, which reverts as one undo step. On-canvas masters keep working, and can be moved to My components.
  - A properties-panel section offers create, go to master, reset overrides (all or per slot), detach, and **Add to my components** for instances from another machine.
  - Edit → Create Component sits in the native menu.
  - The agent gets `list_my_components` and `insert_my_component`.
- **FR-56** **Component properties**: a master declares typed properties (text, colour, boolean visibility, choice) bound to its slots. Each instance sets its own values, which act as overrides; unset values follow the master's defaults. A **Properties** panel section declares properties on a master and edits values on an instance (with reset). The agent gets `define_property`, `remove_property` and `set_properties`.
- **FR-57** **Nested components**: a master can contain instances of other components; the outer component's instances hold copies that still follow the inner master. Cycles are rejected. Overrides and property values work at both levels, and duplicate/paste, orphan promotion, one-step undo and collab (no echo) behave as for single-level components. `insert_instance` takes `into` to nest.

### 4.15 Named styles (DX wave 2)

- **FR-58** **Named styles**: elements link to a named style (stroke and fill colour, fill style, stroke width and style, sloppiness, opacity, edges, font family and size, text colour). Editing the style updates every linked element live, including component instances through their master, as **one undo step**. A direct edit to a linked element becomes a per-element **override** until reset, or can be pushed into the style. Definitions are versioned `customData` on the linked elements (D-DX2), so styles survive save, reload, paste and collab; a style exists while an element uses it. UI: a **Styles** sidebar tab (create from selection, apply, select, rename, edit, delete → unlink) and a **Style** picker in the properties panel. The agent gets `list_styles`, `create_style`, `apply_style`, `update_style`, `delete_style` and `reset_style_overrides`. See `docs/styles.md`.

### 4.16 Smart containers (DX wave 2)

- **FR-59** **Smart containers**: a selection can become a **container**, a group with a tagged background rectangle that stacks its children vertically or horizontally with a gap, padding (per side), cross-axis alignment, main-axis distribution and per-axis hug or fixed size. Children re-flow live, and the box resizes to fit, when a child moves (reorders), resizes, grows from a text edit, or is added or removed. Each user action is **one undo step**, collab peers don't echo, and bound arrows follow. A Container section in the properties panel makes, edits and removes containers and reorders or takes out children; Alt/Option+Shift+A makes one. Containers nest, can sit inside component masters, can hold component instances, and are one node for auto-layout. The agent gets `create_container`, `update_container`, `remove_container`, `add_to_container`, `remove_from_container` and `list_containers` (all `apply_ops`-capable). See `docs/containers.md`.
- **FR-60** **Tidy Arrows**: a one-shot **Layout ▸ Tidy Arrows** command (native Layout menu and toolbar Layout dropdown) MUST re-route the selected arrows (or arrows bound to selected shapes), or every arrow when nothing is selected, as orthogonal elbow paths that avoid the other shapes (groups, frames, containers and component instances count as obstacles), without moving any shape. Arrows leaving the same side of one shape share a trunk (org-chart bus). Ends pinned to a side (FR-53 anchors) keep that side. Only arrows bound at both ends are tidied; **Tidy Arrows (Convert Straight Arrows)** first turns bound straight/curved arrows into elbow arrows (off for the plain command). The result is **one undo step**, routes stay put until a bound shape is moved (Excalidraw then rebuilds only the end legs), and arrows with no clear route are left unchanged with a toast. No live re-routing. The agent gets `tidy_arrows` (`ids`, `convert`), also inside `apply_ops`. The Layout menu and toolbar dropdown come from one shared command list (`src/layout/commands.json`), which also carries the smart-container commands (FR-59).

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
- **SEC-6** Agent engines are spawned only from Rust, with fixed argument builders that always sandbox the engine: writes scoped to the working folder(s), shell behind approval or the no-network sandbox, never an engine allow-all / bypass mode. The opt-in "Allow all for this conversation" (FR-31) is implemented in the app's own approval handler and does not loosen the sandbox. The webview gets no shell or process capability. The MCP server binds 127.0.0.1 only and requires a per-session random token. Child process trees are killed on tab close and on quit.
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
