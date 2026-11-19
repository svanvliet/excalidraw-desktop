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
| `join`      | `room: string`, `protocol: 1`                               | must be the first frame               |
| `broadcast` | `volatile: boolean`, `iv: string(b64)`, `data: string(b64)` | relayed to every _other_ peer in room |

### Relay → client

| type      | fields                                                                                               | notes                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `welcome` | `clientId: string`, `peers: string[]`, `firstInRoom: boolean`                                        | reply to `join`; `peers` excludes self                                               |
| `peers`   | `peers: string[]`                                                                                    | sent to everyone in room whenever membership changes; includes all clientIds in room |
| `message` | `from: string`, `volatile: boolean`, `iv: string`, `data: string`                                    | relayed `broadcast`                                                                  |
| `error`   | `code: "unknown_room" \| "room_full" \| "bad_frame" \| "too_large" \| "protocol"`, `message: string` | `unknown_room`/`room_full`/`protocol` are followed by close                          |

`clientId`: relay-assigned, 16 hex chars. `volatile` messages (cursors) may be
dropped under backpressure; non-volatile must be delivered in order.

When the host calls `collab_stop`, the relay closes all sockets in the room with
close code **4000** ("session ended").

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
  | { type: "FILES_REQUEST"; ids: string[] };
```

Rules:

- Newcomer (`firstInRoom=false`) sends `HELLO` then `SYNC_REQUEST`. The **host**
  answers with `SCENE_INIT` + `FILES` for referenced files. Non-hosts ignore
  `SYNC_REQUEST` unless no host is in the room.
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
}
collab_start(args) -> CollabStatus   // starts relay (idempotent), registers room, starts tunnel
collab_stop() -> CollabStatus        // closes room (4000), stops tunnel host process + relay
collab_status() -> CollabStatus
event "collab://status" (payload CollabStatus) on every change
```

Errors are `AppError` with `kind: "other"`; tunnel failures are reported in
`status.tunnel.error` (relay keeps running so local sessions still work).
Known tunnel error messages: `devtunnel_not_installed`, `devtunnel_not_logged_in`,
`devtunnel_failed: <detail>`.

### DevTunnels (auto mode)

Persistent tunnel ID `excalidraw-desktop` (+ `-<profile>` for test profiles):
`devtunnel show` → create if missing (`devtunnel create <id>`) → ensure port
(`devtunnel port create <id> -p <port> --protocol http`) → anonymous access
(`devtunnel access create <id> --anonymous`) → `devtunnel host <id>` (child
process; killed on stop/app exit). Public base parsed from the host output
(`https://<id>-<port>.<region>.devtunnels.ms`).

## 6. Test profiles (second instance on one machine)

`EXCALIDRAW_DESKTOP_PROFILE=<name>` or `--profile <name>`:
skips the single-instance plugin, appends `-<name>` to the store files
(`settings-<name>.json`, `recent-files-<name>.json`), log file and window title,
and uses default relay port `4780 + 1 + hash(name) % 100`. Exposed to the
frontend via `app_profile() -> string | null`.

## 7. Browser guest mode

When the bundle runs outside Tauri and `location.hash` contains `#room=`, the
app renders `GuestApp`: name prompt (remembered in `localStorage`), a full
Excalidraw editor joined to the room, `LiveCollaborationTrigger` showing
participants, and a banner when the session ends (close 4000) or the
connection drops (auto-reconnect with backoff).
