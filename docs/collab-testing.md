# Live collaboration — pre-release validation

Run this **before every release** that touches collaboration (M10 gate).
Use a **local, unsigned production build** — not `tauri dev` — so the relay
serves the embedded assets exactly as shipped.

```bash
npm run tauri build -- --bundles app       # → src-tauri/target/release/bundle/macos/Excalidraw Desktop.app
APP="src-tauri/target/release/bundle/macos/Excalidraw Desktop.app/Contents/MacOS/excalidraw-desktop"
tail -f ~/.excalidraw-desktop/excalidraw-desktop*.log   # keep open in another terminal
```

Settings → enable **Live collaboration**, set a display name.

## Core checklist (repeat in every stage)

| #   | Check                                                                                  |
| --- | -------------------------------------------------------------------------------------- |
| 1   | Guest joins from the share link; name prompt; host sees participant count go up        |
| 2   | Host's existing drawing appears on the guest immediately (full sync)                   |
| 3   | Shapes drawn on either side appear on the other within ~0.5 s                          |
| 4   | Both edit the **same** element at once → both converge to the same result              |
| 5   | Delete on one side disappears on the other                                             |
| 6   | Live cursor with the correct name is visible both ways; selection highlights show      |
| 7   | Paste an image on the guest → shows on host (and vice versa)                           |
| 8   | Undo on one side undoes only that user's change (remote changes not in local undo)     |
| 9   | Host tab shows dirty after remote edits; ⌘S saves; reopening file contains guest edits |
| 10  | Guest closes tab / rejoins → gets current scene; participant count updates             |
| 11  | Network blip (Wi-Fi off 5 s on guest) → auto-reconnects and catches up                 |
| 12  | Host clicks **Stop session** → guest sees "session ended", can no longer edit live     |
| 13  | Log file has no `ERROR` lines for the session                                          |

## Stage A — desktop build ↔ local browser

1. Launch the built app; tunnel mode **Local**; Start session on a tab with content.
2. Open the local share link (`http://127.0.0.1:<port>/#room=…`) in Safari/Chrome/Edge.
3. Run the core checklist. Also: a second browser window as a third participant.

## Stage B — desktop build ↔ remote browser (user-run)

1. Tunnel mode **Auto** → Start session; status shows tunnel **ready** and a `devtunnels.ms` link.
2. Send the link to a remote device/person on another network; run the core checklist.
3. Repeat with tunnel mode **Manual**: in Tunnel Bar, host a tunnel forwarding to the
   configured port with anonymous access, paste its URL into Settings, Start session.
4. Negative: Auto mode with `devtunnel` logged out → clear actionable error; local link still works.

## Stage C — desktop ↔ second desktop instance

```bash
"$APP" --profile guest      # separate settings/recents/log, no single-instance hand-off
```

1. Host in the normal instance (Auto or Local); in the `guest` instance use **Join session…**
   with the link (try both the tunnel link and the `127.0.0.1` link).
2. Run the core checklist; the guest tab must not overwrite the host's file.

## Recording results

Tick the M10 gate boxes in `docs/status.md` with date + build commit, and note any
issues found (and the fixing commit) in the status changelog.
