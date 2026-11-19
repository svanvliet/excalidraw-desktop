/**
 * Relay transport (docs/collab-protocol.md §3).
 *
 * `RelayTransport` is the seam between the sync engine and the network. The
 * production implementation is {@link WebSocketTransport}; tests use the
 * in-memory relay in `memoryRelay.ts`.
 */
import { log } from "../lib/logger";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  REMOVED_CLOSE_CODE,
  SESSION_ENDED_CLOSE_CODE,
  type ClientFrame,
  type RelayErrorCode,
  type RelayFrame,
} from "./protocol";

/**
 * - `connecting`: first connection attempt in flight
 * - `connected`: `welcome` received; broadcasts are accepted
 * - `reconnecting`: connection dropped; retrying with backoff
 * - `ended`: host ended the session (close 4000) — terminal
 * - `removed`: host removed this peer (close 4001) — terminal
 * - `failed`: relay rejected us (unknown room, full, protocol) — terminal
 * - `closed`: we called `close()` — terminal
 */
export type TransportStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "removed"
  | "failed"
  | "closed";

export type TransportEvent =
  | { type: "status"; status: TransportStatus; error?: { code: RelayErrorCode; message: string } }
  | Extract<RelayFrame, { type: "welcome" | "peers" | "message" | "error" }>;

export interface RelayTransport {
  /** Opens the connection and joins `room`. Reconnects automatically. */
  connect(room: string): void;
  /** Sends a `broadcast` frame. Dropped (returns false) unless connected. */
  broadcast(frame: { volatile: boolean; iv: string; data: string }): boolean;
  /** Closes for good. */
  close(): void;
  /** Subscribes to frames + status changes. Returns an unsubscribe fn. */
  subscribe(listener: (event: TransportEvent) => void): () => void;
  readonly status: TransportStatus;
}

/** Errors after which the relay closes the socket and retrying is pointless. */
const FATAL_ERRORS: ReadonlySet<RelayErrorCode> = new Set([
  "unknown_room",
  "room_full",
  "protocol",
]);

/** Shared fan-out + status bookkeeping for transport implementations. */
export abstract class BaseTransport implements RelayTransport {
  private listeners = new Set<(event: TransportEvent) => void>();
  private _status: TransportStatus = "closed";

  get status(): TransportStatus {
    return this._status;
  }

  abstract connect(room: string): void;
  abstract broadcast(frame: { volatile: boolean; iv: string; data: string }): boolean;
  abstract close(): void;

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: TransportEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (e) {
        log.error("collab transport: listener threw", e);
      }
    }
  }

  protected setStatus(status: TransportStatus, error?: { code: RelayErrorCode; message: string }) {
    if (this._status === status && !error) return;
    this._status = status;
    this.emit(error ? { type: "status", status, error } : { type: "status", status });
  }

  /** Dispatches a parsed relay frame; returns true if the error is fatal. */
  protected handleFrame(frame: RelayFrame): boolean {
    switch (frame.type) {
      case "welcome":
        this.setStatus("connected");
        this.emit(frame);
        return false;
      case "peers":
      case "message":
        this.emit(frame);
        return false;
      case "error": {
        this.emit(frame);
        if (FATAL_ERRORS.has(frame.code)) {
          this.setStatus("failed", { code: frame.code, message: frame.message });
          return true;
        }
        log.warn(`collab transport: relay error ${frame.code}: ${frame.message}`);
        return false;
      }
    }
  }
}

export function isRelayFrame(value: unknown): value is RelayFrame {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  return t === "welcome" || t === "peers" || t === "message" || t === "error";
}

export interface WebSocketTransportOptions {
  /** Injected for tests; defaults to the global `WebSocket`. */
  WebSocketImpl?: typeof WebSocket;
  /** First retry delay; doubles each attempt. Default 500 ms. */
  initialBackoffMs?: number;
  /** Retry delay cap. Default 10 s. */
  maxBackoffMs?: number;
}

export class WebSocketTransport extends BaseTransport {
  private ws: WebSocket | null = null;
  private room: string | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private terminal = false;
  private readonly WS: typeof WebSocket;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly url: string,
    opts: WebSocketTransportOptions = {},
  ) {
    super();
    this.WS = opts.WebSocketImpl ?? globalThis.WebSocket;
    this.initialBackoffMs = opts.initialBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
  }

  connect(room: string): void {
    this.room = room;
    this.terminal = false;
    this.attempt = 0;
    this.setStatus("connecting");
    this.open();
  }

  broadcast(frame: { volatile: boolean; iv: string; data: string }): boolean {
    if (this.status !== "connected" || !this.ws || this.ws.readyState !== this.WS.OPEN) {
      return false;
    }
    const text = JSON.stringify({ type: "broadcast", ...frame } satisfies ClientFrame);
    if (text.length > MAX_FRAME_BYTES) {
      log.warn(`collab transport: dropping ${text.length}-byte frame (> ${MAX_FRAME_BYTES})`);
      return false;
    }
    this.ws.send(text);
    return true;
  }

  close(): void {
    this.terminal = true;
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= this.WS.OPEN) ws.close(1000, "client closed");
    this.setStatus("closed");
  }

  private open(): void {
    if (!this.room) return;
    const room = this.room;
    let ws: WebSocket;
    try {
      ws = new this.WS(this.url);
    } catch (e) {
      log.error("collab transport: WebSocket constructor failed", e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(
        JSON.stringify({ type: "join", room, protocol: PROTOCOL_VERSION } satisfies ClientFrame),
      );
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        log.warn("collab transport: ignoring non-JSON frame");
        return;
      }
      if (!isRelayFrame(frame)) {
        log.warn("collab transport: ignoring unknown frame");
        return;
      }
      if (frame.type === "welcome") this.attempt = 0;
      if (this.handleFrame(frame)) {
        this.terminal = true;
        ws.close();
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === SESSION_ENDED_CLOSE_CODE) {
        this.terminal = true;
        log.info("collab transport: session ended by host");
        this.setStatus("ended");
        return;
      }
      if (ev.code === REMOVED_CLOSE_CODE) {
        this.terminal = true;
        log.info("collab transport: removed by host");
        this.setStatus("removed");
        return;
      }
      if (this.terminal) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // `close` always follows; reconnect is handled there.
    };
  }

  private scheduleReconnect(): void {
    this.clearRetry();
    const delay = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** this.attempt);
    this.attempt++;
    this.setStatus("reconnecting");
    log.info(`collab transport: reconnecting in ${delay}ms (attempt ${this.attempt})`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.terminal) this.open();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
