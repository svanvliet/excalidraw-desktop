# Excalidraw Desktop

A local-first, fully-offline desktop wrapper around the official
[Excalidraw](https://excalidraw.com/) editor, built with
[Tauri 2](https://v2.tauri.app/) + React + TypeScript. macOS and Windows.

> **Privacy contract:** the app does not make a single outbound network
> request out of the box. Live collaboration, the public library
> browser, and the AI text-to-diagram feature are all opt-in toggles in
> Settings that default to **off** and are enforced by a unit test
> (`settingsStore.test.ts`) and an end-to-end Playwright test
> (`e2e/smoke.spec.ts`).

---

## Features

- **Embedded Excalidraw editor.** Same UX as excalidraw.com but with no
  Firebase, no telemetry, no asset fetches from the cloud.
- **Filesystem-native.** Open and save `.excalidraw` JSON straight to
  disk. Export to PNG with the scene embedded in the metadata so the
  PNG itself round-trips back into the editor.
- **OS integration.** `.excalidraw` is registered with the OS via Tauri
  bundle file associations: double-click in Finder/Explorer opens it
  (or attaches a new tab if the app is already running thanks to
  `tauri-plugin-single-instance`). Drag-drop onto the window opens a
  new tab.
- **Tabs.** Multiple documents in one window with per-tab undo history,
  a dirty-close confirmation, and an Open-Recent list (capped at 20,
  persisted via `tauri-plugin-store`).
- **Autosave + session restore.** Every tab autosaves every 2 seconds:
  file-backed tabs overwrite their file; untitled tabs go to an
  app-data scratch directory so they survive a crash. The next launch
  rebuilds the previously open tabs.
- **Native menu bar.** File / Edit / View / Window / Help with
  platform-correct accelerators (Cmd on macOS, Ctrl elsewhere).
- **Settings dialog** for the three opt-in online features and the
  matching API keys / config.

---

## Quickstart

You need [Node ≥ 20](https://nodejs.org/), [Rust](https://rustup.rs/), and
the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for
your OS (Xcode CLT on macOS, Visual Studio C++ Build Tools on Windows).

```bash
git clone <this-repo> excalidraw-desktop
cd excalidraw-desktop
npm install
npm run tauri dev
```

That spawns the desktop shell with Excalidraw loaded. Edit, save, close,
relaunch — your tabs come back.

### One-time Playwright setup (only if you want to run the web smoke tests)

```bash
npm run e2e:install   # downloads chromium
```

---

## Scripts

| Command                  | What it does                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `npm run dev`            | Vite dev server only (no Tauri shell — useful for fast UI iteration).                 |
| `npm run tauri dev`      | Vite dev server + Tauri shell. The real desktop dev loop.                             |
| `npm run build`          | `tsc` + `vite build` → `dist/`. Pre-step for `tauri build`.                           |
| `npm run tauri build`    | Produces a signed-or-unsigned `.app` / `.exe` / `.msi`.                               |
| `npm run check`          | `typecheck` → `lint` → `format:check` → `vitest` → `cargo fmt:check` / clippy / test. |
| `npm test`               | Vitest unit + component tests (`src/**/*.test.{ts,tsx}`).                             |
| `npm run e2e`            | Playwright web-build smoke tests against `vite preview`.                              |
| `npm run e2e:install`    | One-time chromium download for Playwright.                                            |
| `npm run lint`           | ESLint (`--max-warnings 0`).                                                          |
| `npm run format`         | Prettier write.                                                                       |
| `npm run format:check`   | Prettier check only (used in `npm run check`).                                        |
| `npm run typecheck`      | `tsc --noEmit`.                                                                       |
| `npm run rust:fmt:check` | `cargo fmt --check` for the Rust crate.                                               |
| `npm run rust:lint`      | `cargo clippy --all-targets -- -D warnings`.                                          |
| `npm run rust:test`      | `cargo test` for the Rust crate.                                                      |

**Every commit must pass `npm run check`.** See `CLAUDE.md` § Commits.

---

## Project layout

```
docs/                    Requirements, plan, status, signing guides
e2e/                     Playwright smoke tests
src/
  App.tsx                Top-level shell — tabs, autosave, menu wiring
  components/            React components (Toolbar, TabBar, dialogs, canvas)
  stores/                Zustand stores: tabs, recentFiles, session, settings
  lib/                   Pure libraries: file format, autosave, png scene
  ipc/                   Typed wrappers around invoke() + event subscriptions
src-tauri/
  src/
    lib.rs               Tauri builder + RunEvent::Opened + single-instance
    menu.rs              Native menu construction + event forwarding
    commands/            files.rs (open/save/bytes), scratch.rs (autosave)
    error.rs             AppError → JSON shape mirrored in src/ipc/commands.ts
  tauri.conf.json        Bundle config, file associations, plugins
```

---

## Signing & notarization

Producing a distributable build that opens without Gatekeeper /
SmartScreen warnings requires platform-specific signing. We document the
steps so a future developer (or a CI release pipeline — see M9) can
follow them, but the actual signed-release pipeline is **deferred to
post-v1**.

- **macOS:** [`docs/signing-macos.md`](docs/signing-macos.md) — Developer ID,
  `codesign`, `notarytool`, stapling.
- **Windows:** [`docs/signing-windows.md`](docs/signing-windows.md) — code-signing
  cert options, `signtool`, timestamping.

---

## Documentation

- [`docs/requirements.md`](docs/requirements.md) — what we're building and why.
- [`docs/plan.md`](docs/plan.md) — milestones, architecture, decision log.
- [`docs/status.md`](docs/status.md) — live milestone tracker.
- [`CLAUDE.md`](CLAUDE.md) — repo conventions for AI assistants and humans.
