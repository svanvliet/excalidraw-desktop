# Live collaboration — protocol & component contract

> Source of truth for the co-authoring feature (milestone M10). Rust relay, TS
> sync engine, browser guest mode, and any future cloud relay MUST conform to
> this document. Change it in the same commit as any behavior change.

## 1. Topology

```
Host desktop app                                     Guest (browser or 2nd desktop)
┌──────────────────────────────────┐                 ┌───────────────────────────┐
│ React + Excalidraw + CollabSession│                │ same JS bundle            │
│      │ ws://127.0.0.1:<port>/ws   │                │ (guest mode if !Tauri)    │
│ Rust relay (axum, 127.0.0.1 only) │◀── tunnel ───▶ │ wss://<public>/ws         │
│   /ws    room fan-out (opaque)    │  (DevTunnels,  │ https://<public>/#room=…  │
│   /      serves app assets        │   anonymous)   └───────────────────────────┘
│   /healthz                        │
└──────────────────────────────────┘
```

- The relay **never sees plaintext**. It forwards opaque encrypted blobs between
  sockets in the same room.
- The relay binds **127.0.0.1 only**. Remote peers reach it exclusively through a
  tunnel (DevTunnels auto mode, or a user-provided public URL in manual mode).
- The relay only accepts the room IDs the host registered via `collab_start`
  (no open relay for strangers).

## 2. Share link

```
<publicBase>/#room=<roomId>,<key>
```

- `publicBase`: tunnel URL (e.g. `https://abc123-4780.usw3.devtunnels.ms`) or
  `http://127.0.0.1:<port>` for local-only sessions. No trailing slash.
- `roomId`: 20 lowercase hex chars (80 random bits).
- `key`: AES-GCM-128 raw key, base64url without padding (22 chars).
- The fragment never reaches any server. WebSocket URL is derived as
  `publicBase` with `http→ws`, `https→wss`, plus `/ws`.

## 3. Relay wire protocol (JSON text frames over WebSocket)

Protocol version: `1`. Max frame: **8 MiB**. Max peers per room: **32**.
Unknown `type` → `error` frame, connection kept. Malformed JSON → close 1003.

### Client → relay

| type        | fields                                                      | notes                                 |
| ----------- | ----------------------------------------------------------- | ------------------------------------- |
| `join`      | `room: string`, `protocol: 1`, `hostToken?`, `resume?`      | must be the first frame               |
| `broadcast` | `volatile: boolean`, `iv: string(b64)`, `data: string(b64)` | relayed to every _other_ peer in room |

### Relay → client

| type      | fields                                                                                               | notes                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `welcome` | `clientId: string`, `peers: string[]`, `firstInRoom: boolean`, `roles: RolesMap`, `resumeToken`      | reply to `join`; `peers` excludes self; `roles` covers everyone incl. self |
| `peers`   | `peers: string[]`, `roles: RolesMap`                                                                 | sent to everyone in room whenever membership or a role changes             |
| `message` | `from: string`, `volatile: boolean`, `iv: string`, `data: string`                                    | relayed `broadcast`                                                        |
| `error`   | `code: "unknown_room" \| "room_full" \| "bad_frame" \| "too_large" \| "protocol"`, `message: string` | `unknown_room`/`room_full`/`protocol` are followed by close                |

`clientId`: relay-assigned, 16 hex chars.

**Roles.** `RolesMap = Record<clientId, "host" | "editor" | "viewer">`. The
relay is the authority: it assigns roles and stamps `message.from`, so a peer
can't impersonate the host or another client.

- A `join` whose `hostToken` matches the secret registered with the room gets
  `host`. The token is only exposed to the host webview (`CollabStatus.hostToken`).
- Everyone else gets the room's guest default: **`viewer`** in the app relay.
  `relay_standalone` and the e2e Node fixture default to `editor`
  (`--guest-role viewer` overrides).
- `welcome.resumeToken` is opaque. Passing it back as `join.resume` restores
  that client's current role after a reconnect. Browser guests keep it in
  `sessionStorage` (`excalidraw-collab-resume:<roomId>`).
- A relay that omits `roles` is treated as legacy: everyone may edit.
- Test-only: `POST /__role/<room>/<client>/<editor|viewer>` on the fixture
  (and on `relay_standalone --control-port`) sets a role. `volatile` messages (cursors) may be
  dropped under backpressure; non-volatile must be delivered in order.

When the host calls `collab_stop`, the relay closes all sockets in the room with
close code **4000** ("session ended").

When the host calls `collab_remove_peer(clientId)`, the relay closes only that
peer's socket with close code **4001** ("removed by host") and broadcasts the
updated `peers` list. Clients treat 4001 as terminal (status `"removed"`, no
auto-reconnect). This is not a ban: the removed person can still reopen the
link. To revoke access, the host stops the session and starts a new one (new
room id + key).

Other close codes: **1008** after a fatal `error` frame (`unknown_room`,
`room_full`, `protocol`), **1003** malformed JSON, **1013** peer too slow to
drain its non-volatile backlog, **1001** relay shutting down (sockets not yet
in a room). A frame over 8 MiB gets `too_large` (connection kept); binary
frames get `bad_frame`. A `room` that isn't 20 lowercase hex chars is
`unknown_room`. `peerCount` in `CollabStatus` counts every socket in the room,
including the host's own webview.

## 4. Encrypted payloads

Each `broadcast.data` is `AES-GCM(key, iv=12 random bytes, utf8(JSON(payload)))`.

```ts
type Payload =
  | { type: "HELLO"; username: string; isHost: boolean } // on join + on rename
  | { type: "SYNC_REQUEST" } // newcomer asks for full scene
  | { type: "SCENE_INIT"; elements: ExcalidrawElement[] } // full scene (incl. deleted)
  | { type: "SCENE_UPDATE"; elements: ExcalidrawElement[] } // changed elements only
  | {
      type: "MOUSE_LOCATION";
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "down" | "up";
      selectedElementIds: Record<string, true>;
      username: string;
    }
  | { type: "IDLE_STATUS"; userState: "active" | "idle" | "away"; username: string }
  | { type: "FILES"; files: BinaryFileData[] } // images (dataURL inside)
  | { type: "FILES_REQUEST"; ids: string[] }
  | { type: "EDIT_REQUEST" } // viewer asks the host for edit access
  | { type: "EDIT_DENIED"; clientId: string }; // host declines; only that viewer reacts
```

Rules:

- Newcomer (`firstInRoom=false`) sends `HELLO` then `SYNC_REQUEST`. The **host**
  answers with `FILES` for referenced files (sent first, so images resolve on
  arrival) then `SCENE_INIT`. Non-hosts ignore `SYNC_REQUEST` unless no host is
  in the room; then only the **editor** with the lowest `clientId` (excluding
  the requester) answers. Viewers never answer.
- Viewers don't send `SCENE_INIT`/`SCENE_UPDATE`/`FILES` and don't answer
  `FILES_REQUEST`. Receivers also drop those payloads when `from` is a viewer,
  so a modified client can't push edits. Cursors, `HELLO`, `IDLE_STATUS` and
  `EDIT_REQUEST` are allowed from anyone.
- Promotion (`peers` shows the client as `editor`) clears any pending request;
  the promoted client re-marks its scene as synced so it doesn't rebroadcast
  everything. A pending request is re-sent after a reconnect. Requests from
  peers who leave are dropped.
- Merging uses Excalidraw's `reconcileElements` (version / versionNonce).
  Remote updates apply with `CaptureUpdateAction.NEVER` so they don't pollute undo.
- `SCENE_UPDATE` is throttled (~50 ms) and sends only elements whose `version`
  changed since last broadcast. A full `SCENE_INIT` is re-broadcast every 20 s
  as anti-entropy.
- `MOUSE_LOCATION` is `volatile` and throttled to ~30 Hz.
- Unknown file IDs seen in elements trigger `FILES_REQUEST`.
- Collaborators map (`appState.collaborators`) is keyed by relay `clientId`.

## 5. Tauri IPC (host only)

```ts
type TunnelMode = "auto" | "manual" | "local";
interface CollabStartArgs { roomId: string; port: number; tunnel: TunnelMode; manualUrl?: string }
interface CollabStatus {
  running: boolean;
  roomId: string | null;
  localPort: number | null;
  localBase: string | null;          // http://127.0.0.1:<port>
  publicBase: string | null;         // tunnel URL, manualUrl, or localBase for "local"
  tunnel: { mode: TunnelMode | null; state: "off" | "starting" | "ready" | "error"; error: string | null };
  peerCount: number;
  hostToken: string | null;          // secret the host webview passes in `join`
}
collab_start(args) -> CollabStatus   // starts relay (idempotent), registers room, starts tunnel
collab_stop() -> CollabStatus        // closes room (4000), stops tunnel host process + relay
collab_remove_peer(clientId) -> ()  // closes that peer (4001); errors "no active session" / "unknown peer"
collab_set_role(clientId, "editor" | "viewer") -> ()  // same errors; broadcasts `peers`
collab_status() -> CollabStatus
event "collab://status" (payload CollabStatus) on every change
```

`collab_start` returns immediately; in auto mode `tunnel.state` is
`"starting"` and `publicBase` is `null` until a later `collab://status` event
reports `"ready"` (or `"error"`, in which case `publicBase` stays `null`).

Errors are `AppError` with `kind: "other"` (e.g. invalid `roomId`/`manualUrl`,
`relay_bind_failed: <io error>`); tunnel failures are reported in
`status.tunnel.error` (relay keeps running so local sessions still work).
Known tunnel error messages: `devtunnel_not_installed`, `devtunnel_not_logged_in`,
`devtunnel_failed: <detail>`.

### DevTunnels (auto mode)

Persistent tunnel ID `excalidraw-desktop` (+ `-<profile>` for test profiles):
`devtunnel user show` (login check) → `devtunnel show <id> -j` → create if
missing (`devtunnel create <id>`) → delete stale ports, ensure port
(`devtunnel port create <id> -p <port> --protocol http`) → anonymous access
(`devtunnel access create <id> --anonymous`) → `devtunnel host <id>` (child
process; killed on stop/app exit). Public base parsed from the host's
`Connect via browser: <url>` line once it prints `Ready to accept connections`.
The hostname is a service-assigned token, **not** the tunnel ID
(`https://<token>-<port>.<region>.devtunnels.ms`).

## 6. Test profiles (second instance on one machine)

`EXCALIDRAW_DESKTOP_PROFILE=<name>` or `--profile <name>`:
skips the single-instance plugin, appends `-<name>` to the store files
(`settings-<name>.json`, `recent-files-<name>.json`), log file and window title,
and uses default relay port `4780 + 1 + hash(name) % 100`, where `hash` is
32-bit FNV-1a over the UTF-8 name. Names must match `[A-Za-z0-9_-]{1,32}`
(invalid names are ignored); `--profile` wins over the env var. Exposed to the
frontend via `app_profile() -> string | null`.

## 7. Browser guest mode

When the bundle runs outside Tauri and `location.hash` contains `#room=`, the
app renders `GuestApp`: name prompt (remembered in `localStorage`), a full
Excalidraw editor joined to the room, a top-right "Live N" button (styled
like Excalidraw's Library button) that opens a session panel (participants,
rename, Leave session), and a banner when the session ends (close 4000), the
host removes the guest (close 4001), or the connection drops (auto-reconnect
with backoff).

Guests start as viewers: the canvas is in Excalidraw view mode and a bar
says "You're viewing this drawing." with **Ask to edit**. The host sees
"<name> wants to edit this drawing." with **Allow**/**Deny** above the canvas,
plus the same buttons, a role tag, and a **Make editor**/**Make viewer** toggle
for each person in the Share dialog's participant list. Guests see the same
list (read-only) in their Live panel. When the host removes a guest, the
guest's canvas is cleared after the socket closes; the host's scene is untouched.
