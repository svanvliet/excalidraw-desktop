#!/usr/bin/env node
/**
 * Reference implementation of the collab relay wire protocol
 * (docs/collab-protocol.md §3) for end-to-end tests. Also serves a built
 * `dist/` so browser guests can load the app from the same origin.
 *
 *   node e2e/fixtures/relay.mjs --port 4174 --dist dist --room <20-hex>[,<20-hex>]
 *
 * Without `--room` (or RELAY_ROOMS) any well-formed room id is accepted.
 * Test-only admin endpoint: `POST /__end/<room>` closes the room with 4000.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer } from "ws";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PEERS_PER_ROOM = 32;
const SESSION_ENDED = 4000;
const ROOM_RE = /^[0-9a-f]{20}$/;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const port = Number(arg("port", process.env.RELAY_PORT ?? "4174"));
const host = arg("host", "127.0.0.1");
const distDir = resolve(arg("dist", "dist"));
const allowed = arg("room", process.env.RELAY_ROOMS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/** @type {Map<string, Map<string, import("ws").WebSocket>>} */
const rooms = new Map();

function roomAllowed(room) {
  return ROOM_RE.test(room) && (allowed.length === 0 || allowed.includes(room));
}

function send(ws, frame) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function broadcastPeers(room) {
  const members = rooms.get(room);
  if (!members) return;
  const peers = [...members.keys()];
  for (const ws of members.values()) send(ws, { type: "peers", peers });
}

function serveStatic(req, res) {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  const end = url.pathname.match(/^\/__end\/([0-9a-f]{20})$/);
  if (end && req.method === "POST") {
    for (const ws of rooms.get(end[1])?.values() ?? []) ws.close(SESSION_ENDED, "session ended");
    res.writeHead(204).end();
    return;
  }
  let file = normalize(join(distDir, decodeURIComponent(url.pathname)));
  if (!file.startsWith(distDir)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("dist/ not built");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const server = createServer(serveStatic);
// Accept slightly oversize frames so we can answer with `too_large` instead of a hard close.
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_FRAME_BYTES * 2 });

wss.on("connection", (ws) => {
  const clientId = randomBytes(8).toString("hex");
  let room = null;

  const fatal = (code, message, closeCode = 1008) => {
    send(ws, { type: "error", code, message });
    ws.close(closeCode, code);
  };

  ws.on("message", (raw, isBinary) => {
    if (raw.length > MAX_FRAME_BYTES) {
      send(ws, { type: "error", code: "too_large", message: "frame exceeds 8 MiB" });
      return;
    }
    if (isBinary) {
      send(ws, { type: "error", code: "bad_frame", message: "binary frames are not supported" });
      return;
    }
    let frame;
    try {
      frame = JSON.parse(raw.toString("utf8"));
    } catch {
      ws.close(1003, "malformed json");
      return;
    }
    if (!frame || typeof frame !== "object") {
      send(ws, { type: "error", code: "bad_frame", message: "frame must be an object" });
      return;
    }

    if (room === null) {
      if (frame.type !== "join") return fatal("protocol", "first frame must be join");
      if (frame.protocol !== PROTOCOL_VERSION) return fatal("protocol", "unsupported protocol");
      if (typeof frame.room !== "string" || !roomAllowed(frame.room)) {
        return fatal("unknown_room", "room not found");
      }
      const members = rooms.get(frame.room) ?? new Map();
      if (members.size >= MAX_PEERS_PER_ROOM) return fatal("room_full", "room is full");
      room = frame.room;
      const firstInRoom = members.size === 0;
      const peers = [...members.keys()];
      members.set(clientId, ws);
      rooms.set(room, members);
      send(ws, { type: "welcome", clientId, peers, firstInRoom });
      broadcastPeers(room);
      return;
    }

    if (frame.type === "broadcast") {
      if (
        typeof frame.volatile !== "boolean" ||
        typeof frame.iv !== "string" ||
        typeof frame.data !== "string"
      ) {
        send(ws, { type: "error", code: "bad_frame", message: "invalid broadcast" });
        return;
      }
      const out = JSON.stringify({
        type: "message",
        from: clientId,
        volatile: frame.volatile,
        iv: frame.iv,
        data: frame.data,
      });
      for (const [id, peer] of rooms.get(room) ?? []) {
        if (id === clientId || peer.readyState !== peer.OPEN) continue;
        // Volatile frames may be dropped under backpressure (§3).
        if (frame.volatile && peer.bufferedAmount > 1024 * 1024) continue;
        peer.send(out);
      }
      return;
    }

    send(ws, { type: "error", code: "bad_frame", message: `unknown type ${frame.type}` });
  });

  ws.on("close", () => {
    if (room === null) return;
    const members = rooms.get(room);
    members?.delete(clientId);
    if (members && members.size === 0) rooms.delete(room);
    else broadcastPeers(room);
  });

  ws.on("error", () => {});
});

wss.on("error", () => {});

server.listen(port, host, () => {
  process.stdout.write(
    `relay listening on http://${host}:${port} (rooms: ${allowed.join(",") || "any"})\n`,
  );
});
