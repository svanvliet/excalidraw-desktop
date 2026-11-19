import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketTransport, type TransportEvent } from "./transport";

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.serverClose(1000);
  }
  // test helpers
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  frame(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  serverClose(code: number) {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];

function make() {
  const t = new WebSocketTransport("ws://127.0.0.1:4780/ws", {
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    initialBackoffMs: 100,
    maxBackoffMs: 400,
  });
  const events: TransportEvent[] = [];
  t.subscribe((e) => events.push(e));
  const statuses = () => events.filter((e) => e.type === "status").map((e) => e.status);
  return { t, events, statuses };
}

const WELCOME = { type: "welcome", clientId: "c1", peers: [], firstInRoom: true };

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("WebSocketTransport", () => {
  it("joins on open and only broadcasts after welcome", () => {
    const { t, events, statuses } = make();
    t.connect("room1");
    expect(latest().url).toBe("ws://127.0.0.1:4780/ws");
    latest().open();
    expect(latest().sent).toEqual([{ type: "join", room: "room1", protocol: 1 }]);
    expect(t.broadcast({ volatile: false, iv: "i", data: "d" })).toBe(false);

    latest().frame(WELCOME);
    latest().frame({ type: "peers", peers: ["c1", "c2"] });
    latest().frame({ type: "message", from: "c2", volatile: true, iv: "i", data: "d" });
    expect(t.broadcast({ volatile: true, iv: "i", data: "d" })).toBe(true);

    expect(latest().sent[1]).toEqual({ type: "broadcast", volatile: true, iv: "i", data: "d" });
    expect(statuses()).toEqual(["connecting", "connected"]);
    expect(events.map((e) => e.type)).toEqual(["status", "status", "welcome", "peers", "message"]);
  });

  it("reconnects with exponential backoff and resets after welcome", () => {
    const { t, statuses } = make();
    t.connect("room1");
    latest().open();
    latest().serverClose(1006);
    expect(statuses().slice(-1)[0]).toBe("reconnecting");

    vi.advanceTimersByTime(99);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    latest().serverClose(1006);
    vi.advanceTimersByTime(199);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    latest().open();
    expect(latest().sent).toEqual([{ type: "join", room: "room1", protocol: 1 }]);
    latest().frame(WELCOME);
    expect(statuses().slice(-1)[0]).toBe("connected");
    latest().serverClose(1006);
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("stops on close code 4000 with status 'ended'", () => {
    const { t, statuses } = make();
    t.connect("room1");
    latest().open();
    latest().frame(WELCOME);
    latest().serverClose(4000);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses().slice(-1)[0]).toBe("ended");
    expect(t.status).toBe("ended");
  });

  it("fails without retry on fatal relay errors", () => {
    const { t, events } = make();
    t.connect("room1");
    latest().open();
    latest().frame({ type: "error", code: "unknown_room", message: "nope" });
    latest().serverClose(1008);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(t.status).toBe("failed");
    expect(events).toContainEqual({
      type: "status",
      status: "failed",
      error: { code: "unknown_room", message: "nope" },
    });
  });

  it("keeps the connection on non-fatal errors and ignores junk frames", () => {
    const { t } = make();
    t.connect("room1");
    latest().open();
    latest().frame(WELCOME);
    latest().frame({ type: "error", code: "bad_frame", message: "x" });
    latest().onmessage?.({ data: "not json" });
    latest().frame({ type: "mystery" });
    expect(t.status).toBe("connected");
  });

  it("close() is terminal", () => {
    const { t, statuses } = make();
    t.connect("room1");
    latest().open();
    latest().frame(WELCOME);
    t.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses().slice(-1)[0]).toBe("closed");
  });
});
