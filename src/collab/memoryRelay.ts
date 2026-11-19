/**
 * In-memory relay + transport implementing the §3 wire semantics. Used by unit
 * tests to wire several CollabSessions together without sockets.
 *
 * Delivery is asynchronous (microtask) and ordered per connection, like a real
 * socket. Call `await relay.flush()` to drain pending deliveries.
 */
import { BaseTransport, type TransportStatus } from "./transport";
import { MAX_PEERS_PER_ROOM, SESSION_ENDED_CLOSE_CODE, type RelayFrame } from "./protocol";

let nextId = 1;
function makeClientId(): string {
  return (nextId++).toString(16).padStart(16, "0");
}

export class MemoryRelay {
  private rooms = new Map<string, Set<MemoryTransport>>();
  private pending = 0;
  private idleWaiters: Array<() => void> = [];
  /** Every broadcast seen by the relay, for assertions. */
  readonly log: Array<{ room: string; from: string; volatile: boolean }> = [];

  constructor(private readonly allowedRooms?: ReadonlySet<string>) {}

  createTransport(): MemoryTransport {
    return new MemoryTransport(this);
  }

  peersIn(room: string): string[] {
    return [...(this.rooms.get(room) ?? [])].map((t) => t.clientId!);
  }

  /** Simulates `collab_stop`: closes every socket in the room with 4000. */
  endRoom(room: string): void {
    for (const t of [...(this.rooms.get(room) ?? [])]) {
      this.leave(t);
      t._closed(SESSION_ENDED_CLOSE_CODE);
    }
  }

  /** Simulates a network drop for one client (non-4000 close). */
  drop(t: MemoryTransport): void {
    this.leave(t);
    t._closed(1006);
  }

  /** Resolves when every queued delivery (including cascades) has run. */
  async flush(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (this.pending === 0) {
        // Let promise chains (encrypt/decrypt) settle, then re-check.
        await new Promise((r) => setTimeout(r, 0));
        if (this.pending === 0) return;
      }
      await new Promise<void>((r) => this.idleWaiters.push(r));
    }
  }

  private deliver(t: MemoryTransport, frame: RelayFrame): void {
    this.pending++;
    queueMicrotask(() => {
      try {
        if (t.clientId && t._room) t._receive(frame);
      } finally {
        this.pending--;
        if (this.pending === 0) this.idleWaiters.splice(0).forEach((w) => w());
      }
    });
  }

  /** @internal */
  _join(t: MemoryTransport, room: string): void {
    if (this.allowedRooms && !this.allowedRooms.has(room)) {
      t._receive({ type: "error", code: "unknown_room", message: "unknown room" });
      return;
    }
    const members = this.rooms.get(room) ?? new Set<MemoryTransport>();
    if (members.size >= MAX_PEERS_PER_ROOM) {
      t._receive({ type: "error", code: "room_full", message: "room full" });
      return;
    }
    const peers = [...members].map((m) => m.clientId!);
    t.clientId = makeClientId();
    t._room = room;
    members.add(t);
    this.rooms.set(room, members);
    this.deliver(t, {
      type: "welcome",
      clientId: t.clientId,
      peers,
      firstInRoom: peers.length === 0,
    });
    this.announce(room);
  }

  /** @internal */
  _broadcast(t: MemoryTransport, volatile: boolean, iv: string, data: string): void {
    const room = t._room;
    if (!room || !t.clientId) return;
    this.log.push({ room, from: t.clientId, volatile });
    for (const m of this.rooms.get(room) ?? []) {
      if (m === t) continue;
      this.deliver(m, { type: "message", from: t.clientId, volatile, iv, data });
    }
  }

  /** @internal */
  leave(t: MemoryTransport): void {
    const room = t._room;
    if (!room) return;
    const members = this.rooms.get(room);
    members?.delete(t);
    t._room = null;
    t.clientId = null;
    if (members && members.size === 0) this.rooms.delete(room);
    else this.announce(room);
  }

  private announce(room: string): void {
    const members = [...(this.rooms.get(room) ?? [])];
    const peers = members.map((m) => m.clientId!);
    for (const m of members) this.deliver(m, { type: "peers", peers });
  }
}

export class MemoryTransport extends BaseTransport {
  clientId: string | null = null;
  /** @internal */
  _room: string | null = null;
  private wantedRoom: string | null = null;

  constructor(private readonly relay: MemoryRelay) {
    super();
  }

  connect(room: string): void {
    this.wantedRoom = room;
    this.setStatus("connecting");
    this.relay._join(this, room);
  }

  /** Re-joins after `relay.drop(this)` — what WebSocketTransport's backoff does. */
  reconnect(): void {
    if (this.wantedRoom && this.status === "reconnecting") this.relay._join(this, this.wantedRoom);
  }

  broadcast(frame: { volatile: boolean; iv: string; data: string }): boolean {
    if (this.status !== "connected") return false;
    this.relay._broadcast(this, frame.volatile, frame.iv, frame.data);
    return true;
  }

  close(): void {
    this.relay.leave(this);
    this.setStatus("closed");
  }

  /** @internal */
  _receive(frame: RelayFrame): void {
    this.handleFrame(frame);
  }

  /** @internal */
  _closed(code: number): void {
    const next: TransportStatus = code === SESSION_ENDED_CLOSE_CODE ? "ended" : "reconnecting";
    this.setStatus(next);
  }
}
