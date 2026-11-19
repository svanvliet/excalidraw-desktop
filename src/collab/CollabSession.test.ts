vi.hoisted(() => {
  // Excalidraw probes canvas 2D support at import time; jsdom has none.
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  SceneData,
  SocketId,
} from "@excalidraw/excalidraw/types";

import {
  CollabSession,
  type CollabApi,
  type CollabSessionOptions,
  type CollabStatus,
  type CollabTiming,
} from "./CollabSession";
import { MEMORY_HOST_TOKEN, MemoryRelay, type MemoryTransport } from "./memoryRelay";
import type { Payload } from "./protocol";

const ROOM = "0123456789abcdef0123";
const KEY = "AAAAAAAAAAAAAAAAAAAAAA";

let nonce = 1000;

function rect(id: string, index: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: nonce++,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  } as unknown as OrderedExcalidrawElement;
}

function image(id: string, index: string, fileId: string) {
  return rect(id, index, { type: "image", fileId, status: "saved", scale: [1, 1], crop: null });
}

function file(id: string): BinaryFileData {
  return {
    id,
    mimeType: "image/png",
    dataURL: `data:image/png;base64,${id}`,
    created: 1,
  } as unknown as BinaryFileData;
}

/** Mimics the bits of Excalidraw's imperative API the engine touches. */
class FakeApi implements CollabApi {
  elements: OrderedExcalidrawElement[] = [];
  files: BinaryFiles = {};
  appState = {
    selectedElementIds: {} as Record<string, true>,
    collaborators: new Map<SocketId, Collaborator>(),
  };
  /** Excalidraw calls onChange after every scene update, including programmatic ones. */
  onChange: ((els: readonly OrderedExcalidrawElement[]) => void) | null = null;

  updateScene = vi.fn((data: SceneData) => {
    if (data.elements) this.elements = [...(data.elements as OrderedExcalidrawElement[])];
    if (data.collaborators) this.appState.collaborators = data.collaborators;
    this.onChange?.(this.elements);
  }) as unknown as CollabApi["updateScene"];
  getSceneElementsIncludingDeleted = () => this.elements;
  getAppState = () => this.appState as unknown as AppState;
  getFiles = () => this.files;
  addFiles = (data: BinaryFileData[]) => {
    for (const f of data) this.files = { ...this.files, [f.id]: f };
  };

  /** A local user edit: new version + nonce, then onChange. */
  edit(id: string, patch: Record<string, unknown>) {
    this.elements = this.elements.map((el) =>
      el.id === id
        ? ({ ...el, ...patch, version: el.version + 1, versionNonce: nonce++ } as typeof el)
        : el,
    );
    this.onChange?.(this.elements);
  }

  add(el: OrderedExcalidrawElement) {
    this.elements = [...this.elements, el];
    this.onChange?.(this.elements);
  }

  get(id: string) {
    return this.elements.find((e) => e.id === id);
  }

  collaborator(clientId: string) {
    return this.appState.collaborators.get(clientId as SocketId);
  }
}

const FAST: Partial<CollabTiming> = {
  sceneThrottleMs: 5,
  pointerThrottleMs: 20,
  antiEntropyMs: 1_000_000,
  idleAfterMs: 1_000_000,
};

interface Peer {
  api: FakeApi;
  session: CollabSession;
  transport: MemoryTransport;
  statuses: CollabStatus[];
  remoteChanges: number;
  sent: Payload[];
}

const live: Peer[] = [];

function makePeer(
  relay: MemoryRelay,
  opts: {
    username: string;
    isHost?: boolean;
    elements?: OrderedExcalidrawElement[];
    files?: BinaryFiles;
    timing?: Partial<CollabTiming>;
    start?: boolean;
  },
): Peer {
  const api = new FakeApi();
  api.elements = opts.elements ?? [];
  api.files = opts.files ?? {};
  const transport = relay.createTransport({
    hostToken: opts.isHost ? MEMORY_HOST_TOKEN : null,
  });
  const peer = { api, transport, statuses: [], remoteChanges: 0, sent: [] } as unknown as Peer;
  peer.session = new CollabSession({
    transport,
    roomId: ROOM,
    key: KEY,
    username: opts.username,
    isHost: opts.isHost ?? false,
    api,
    timing: { ...FAST, ...opts.timing },
    onStatus: (s) => peer.statuses.push(s),
    onRemoteChange: () => peer.remoteChanges++,
  });
  // Record every outgoing payload type for assertions.
  const send = (peer.session as unknown as { send: (p: Payload, v?: boolean) => void }).send.bind(
    peer.session,
  );
  (peer.session as unknown as { send: (p: Payload, v?: boolean) => void }).send = (p, v) => {
    peer.sent.push(p);
    send(p, v);
  };
  api.onChange = (els) => peer.session.onSceneChange(els);
  if (opts.start !== false) peer.session.start();
  live.push(peer);
  return peer;
}

const last = <T>(xs: T[]) => xs[xs.length - 1];
const types = (p: Peer) => p.sent.map((m) => m.type);
const versions = (p: Peer) =>
  p.api.elements.map((e) => `${e.id}@${e.version}:${e.versionNonce}:${e.isDeleted ? "x" : ""}`);

async function settle(relay: MemoryRelay, ms = 40) {
  await relay.flush();
  await new Promise((r) => setTimeout(r, ms));
  await relay.flush();
}

afterEach(async () => {
  for (const p of live.splice(0)) await p.session.stop();
});

describe("CollabSession", () => {
  it("newcomer sends HELLO + SYNC_REQUEST; host answers with SCENE_INIT and FILES", async () => {
    const relay = new MemoryRelay();
    const host = makePeer(relay, {
      username: "Host",
      isHost: true,
      elements: [rect("a", "a0"), image("img", "a1", "f1")],
      files: { f1: file("f1") },
    });
    await settle(relay);
    const guest = makePeer(relay, { username: "Guest" });
    await settle(relay);

    expect(types(guest).slice(0, 2)).toEqual(["HELLO", "SYNC_REQUEST"]);
    expect(types(host)).toContain("SCENE_INIT");
    expect(types(host)).toContain("FILES");
    expect(guest.api.elements.map((e) => e.id)).toEqual(["a", "img"]);
    expect(guest.api.files.f1?.dataURL).toBe(file("f1").dataURL);
    expect(guest.remoteChanges).toBeGreaterThan(0);
    expect(guest.statuses).toEqual(["connecting", "connected"]);
    expect(guest.session.peers).toEqual([
      expect.objectContaining({ username: "Host", isHost: true }),
    ]);
    expect(host.session.peers).toEqual([
      expect.objectContaining({ username: "Guest", isHost: false }),
    ]);
  });

  it("only the host answers SYNC_REQUEST when one is present", async () => {
    const relay = new MemoryRelay();
    const host = makePeer(relay, { username: "H", isHost: true, elements: [rect("a", "a0")] });
    await settle(relay);
    const g1 = makePeer(relay, { username: "G1" });
    await settle(relay);
    g1.sent.length = 0;
    const g2 = makePeer(relay, { username: "G2" });
    await settle(relay);

    expect(types(g1)).not.toContain("SCENE_INIT");
    expect(types(host).filter((t) => t === "SCENE_INIT")).toHaveLength(2);
    expect(g2.api.get("a")).toBeDefined();
  });

  it("with no host, exactly one existing guest answers SYNC_REQUEST", async () => {
    const relay = new MemoryRelay();
    const g1 = makePeer(relay, { username: "G1", elements: [rect("a", "a0")] });
    await settle(relay);
    const g2 = makePeer(relay, { username: "G2" });
    await settle(relay);
    g1.sent.length = 0;
    g2.sent.length = 0;
    const g3 = makePeer(relay, { username: "G3" });
    await settle(relay);

    const answers = [g1, g2].filter((p) => types(p).includes("SCENE_INIT"));
    expect(answers).toHaveLength(1);
    expect(g3.api.get("a")).toBeDefined();
  });

  it("propagates local edits as throttled SCENE_UPDATEs without echo loops", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "A", isHost: true, elements: [rect("x", "a0")] });
    await settle(relay);
    const b = makePeer(relay, { username: "B" });
    await settle(relay);
    a.sent.length = 0;
    b.sent.length = 0;
    const remoteBefore = a.remoteChanges;

    for (let i = 1; i <= 5; i++) a.api.edit("x", { x: i * 10 });
    await settle(relay);

    expect(b.api.get("x")?.x).toBe(50);
    expect(types(a).filter((t) => t === "SCENE_UPDATE")).toHaveLength(1);
    // Applying the remote update fired B's onChange, but nothing was re-broadcast.
    expect(types(b)).not.toContain("SCENE_UPDATE");
    expect(a.remoteChanges).toBe(remoteBefore);
    expect(b.remoteChanges).toBeGreaterThan(0);
    // Remote updates must not enter the undo stack.
    const lastScene = (b.api.updateScene as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as SceneData)
      .filter((d) => d.elements)
      .pop();
    expect(lastScene?.captureUpdate).toBe("NEVER");

    const logLen = relay.log.length;
    await settle(relay, 60);
    expect(relay.log.length).toBe(logLen);
  });

  it("converges on concurrent edits and adds across three peers", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "A", isHost: true, elements: [rect("x", "a0")] });
    await settle(relay);
    const b = makePeer(relay, { username: "B" });
    const c = makePeer(relay, { username: "C" });
    await settle(relay);

    a.api.edit("x", { x: 100 });
    b.api.edit("x", { x: 200 });
    c.api.edit("x", { y: 300 });
    a.api.add(rect("fromA", "a1"));
    b.api.add(rect("fromB", "a2"));
    await settle(relay, 80);

    expect(versions(b)).toEqual(versions(a));
    expect(versions(c)).toEqual(versions(a));
    expect(a.api.elements.map((e) => e.id).sort()).toEqual(["fromA", "fromB", "x"]);
  });

  it("propagates deletions", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, {
      username: "A",
      isHost: true,
      elements: [rect("x", "a0"), rect("y", "a1")],
    });
    await settle(relay);
    const b = makePeer(relay, { username: "B" });
    await settle(relay);

    b.api.edit("x", { isDeleted: true });
    await settle(relay);

    expect(a.api.get("x")?.isDeleted).toBe(true);
    expect(a.api.get("y")?.isDeleted).toBe(false);
  });

  it("shows remote cursors keyed by clientId and removes them when the peer leaves", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "Alice", isHost: true });
    await settle(relay);
    const b = makePeer(relay, { username: "Bob" });
    await settle(relay);
    const bId = b.transport.clientId!;

    b.api.appState.selectedElementIds = { x: true };
    for (let i = 0; i < 10; i++) {
      b.session.onPointerUpdate({ pointer: { x: i, y: 2 * i, tool: "pointer" }, button: "up" });
    }
    await settle(relay, 50);

    const collab = a.api.collaborator(bId);
    expect(collab).toMatchObject({
      username: "Bob",
      pointer: { x: 9, y: 18, tool: "pointer" },
      button: "up",
      selectedElementIds: { x: true },
      isCurrentUser: false,
    });
    // Leading + trailing edge only.
    expect(types(b).filter((t) => t === "MOUSE_LOCATION").length).toBeLessThanOrEqual(2);
    expect(relay.log.filter((m) => m.from === bId && m.volatile).length).toBeGreaterThan(0);

    await b.session.stop();
    await settle(relay);
    expect(a.api.collaborator(bId)).toBeUndefined();
    expect(a.session.peers).toEqual([]);
  });

  it("requests unknown files and any peer holding them answers", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "A", isHost: true });
    await settle(relay);
    const b = makePeer(relay, { username: "B" });
    const c = makePeer(relay, { username: "C", files: { f9: file("f9") } });
    await settle(relay);

    // A references a file it doesn't have locally (e.g. still loading).
    a.api.add(image("img", "a0", "f9"));
    await settle(relay, 60);

    expect(types(b)).toContain("FILES_REQUEST");
    expect(types(c)).toContain("FILES");
    expect(b.api.files.f9).toBeDefined();
    expect(a.api.files.f9).toBeDefined();
  });

  it("proactively shares files for newly added local images", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "A", isHost: true });
    await settle(relay);
    const b = makePeer(relay, { username: "B" });
    await settle(relay);

    a.api.files = { f1: file("f1") };
    a.api.add(image("img", "a0", "f1"));
    await settle(relay);

    expect(types(a)).toContain("FILES");
    expect(types(b)).not.toContain("FILES_REQUEST");
    expect(b.api.files.f1).toBeDefined();
  });

  it("reports 'ended' and clears collaborators when the host ends the session", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "A", isHost: true });
    const b = makePeer(relay, { username: "B" });
    await settle(relay);
    expect(b.api.appState.collaborators.size).toBe(1);

    relay.endRoom(ROOM);
    await settle(relay);

    expect(last(b.statuses)).toBe("ended");
    expect(last(a.statuses)).toBe("ended");
    expect(b.api.appState.collaborators.size).toBe(0);
  });

  it("reports 'removed' only to the peer the host removed", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "A", isHost: true });
    const b = makePeer(relay, { username: "B" });
    await settle(relay);

    relay.kick(b.transport);
    await settle(relay);

    expect(last(b.statuses)).toBe("removed");
    expect(b.api.appState.collaborators.size).toBe(0);
    expect(last(a.statuses)).toBe("connected");
    expect(a.api.appState.collaborators.size).toBe(0);
  });

  it("re-broadcasts the full scene after reconnecting so offline edits arrive", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "A", isHost: true, elements: [rect("x", "a0")] });
    await settle(relay);
    const b = makePeer(relay, { username: "B" });
    await settle(relay);

    relay.drop(b.transport);
    await settle(relay);
    expect(last(b.statuses)).toBe("reconnecting");
    b.api.edit("x", { x: 999 });
    await settle(relay);
    expect(a.api.get("x")?.x).toBe(0);

    b.transport.reconnect();
    await settle(relay);
    expect(last(b.statuses)).toBe("connected");
    expect(a.api.get("x")?.x).toBe(999);
  });

  it("anti-entropy SCENE_INIT repairs missed updates", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, {
      username: "A",
      isHost: true,
      elements: [rect("x", "a0")],
      timing: { antiEntropyMs: 30 },
    });
    await settle(relay);
    const b = makePeer(relay, { username: "B" });
    await settle(relay);

    // Mutate without onChange, as if an update had been lost.
    a.api.elements = a.api.elements.map((e) => ({ ...e, x: 42, version: e.version + 1 }));
    await settle(relay, 80);

    expect(b.api.get("x")?.x).toBe(42);
  });

  it("broadcasts IDLE_STATUS and renames via HELLO", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "A", isHost: true });
    await settle(relay);
    const b = makePeer(relay, { username: "B", timing: { idleAfterMs: 20 } });
    await settle(relay, 60);
    const bId = b.transport.clientId!;

    expect(a.api.collaborator(bId)?.userState).toBe("idle");
    b.session.onPointerUpdate({ pointer: { x: 1, y: 1, tool: "pointer" }, button: "up" });
    await settle(relay, 5);
    expect(a.api.collaborator(bId)?.userState).toBe("active");

    b.session.setUsername("Bobby");
    await settle(relay);
    expect(a.session.peers[0]).toMatchObject({ clientId: bId, username: "Bobby" });
    expect(a.api.collaborator(bId)?.username).toBe("Bobby");
  });

  it("ignores messages encrypted with a different key", async () => {
    const relay = new MemoryRelay();
    const a = makePeer(relay, { username: "A", isHost: true, elements: [rect("x", "a0")] });
    await settle(relay);
    const intruder = relay.createTransport();
    intruder.connect(ROOM);
    await settle(relay);
    intruder.broadcast({ volatile: false, iv: "AAAAAAAAAAAAAAAA", data: "Zm9vYmFy" });
    await settle(relay);

    expect(a.api.elements).toHaveLength(1);
    expect(a.remoteChanges).toBe(0);
    intruder.close();
  });

  describe("initial view", () => {
    const view = (w: number, h: number, scrollX = 0, scrollY = 0) => ({
      width: w,
      height: h,
      scrollX,
      scrollY,
      zoom: { value: 1 },
      offsetLeft: 0,
      offsetTop: 0,
    });
    const viewCalls = (p: Peer) =>
      (p.api.updateScene as unknown as ReturnType<typeof vi.fn>).mock.calls
        .map(
          (c) => (c[0] as { appState?: { scrollX?: number; zoom?: { value: number } } }).appState,
        )
        .filter((st) => st && st.scrollX !== undefined);

    it("a joining guest opens on the host's visible area, once", async () => {
      const relay = new MemoryRelay();
      const host = makePeer(relay, { username: "H", isHost: true, elements: [rect("a", "a0")] });
      Object.assign(host.api.appState, view(1000, 500, -200, -100));
      await settle(relay);
      const g = makePeer(relay, { username: "G", start: false });
      Object.assign(g.api.appState, view(500, 250));
      g.session.start();
      await settle(relay);

      const calls = viewCalls(g);
      expect(calls).toHaveLength(1);
      // Host sees scene x∈[200,1200], y∈[100,600]; a half-size guest window frames it at 0.5×.
      expect(calls[0]?.zoom?.value).toBe(0.5);
      expect(calls[0]?.scrollX).toBeCloseTo(-200);
      expect(viewCalls(host)).toHaveLength(0);

      // A later full scene (anti-entropy / reconnect) never moves the guest again.
      (host.session as unknown as { broadcastFullScene: (v?: boolean) => void }).broadcastFullScene(
        true,
      );
      await settle(relay);
      expect(viewCalls(g)).toHaveLength(1);
    });
  });

  describe("roles", () => {
    const forge = (p: Peer, payload: Payload) =>
      (p.session as unknown as { send: (x: Payload) => void }).send(payload);

    it("viewers can't edit: no broadcasts, and forged edits are dropped", async () => {
      const relay = new MemoryRelay(undefined, { guestRole: "viewer" });
      const host = makePeer(relay, { username: "H", isHost: true, elements: [rect("a", "a0")] });
      await settle(relay);
      const v = makePeer(relay, { username: "V" });
      await settle(relay);
      expect(v.session.role).toBe("viewer");
      expect(host.session.peers[0]).toMatchObject({ role: "viewer", isHost: false });
      expect(v.api.get("a")).toBeDefined();

      v.sent.length = 0;
      v.api.edit("a", { x: 999 });
      await settle(relay);
      expect(types(v)).not.toContain("SCENE_UPDATE");

      forge(v, { type: "SCENE_UPDATE", elements: [{ ...rect("evil", "a1") }] as never });
      await settle(relay);
      expect(host.api.get("evil")).toBeUndefined();
      expect(host.api.get("a")?.x).not.toBe(999);
    });

    it("request, deny, then promote via set_role", async () => {
      const relay = new MemoryRelay(undefined, { guestRole: "viewer" });
      const host = makePeer(relay, { username: "H", isHost: true, elements: [rect("a", "a0")] });
      await settle(relay);
      const states: string[] = [];
      const roles: string[] = [];
      const v = makePeer(relay, { username: "V", start: false });
      (v.session as unknown as { opts: CollabSessionOptions }).opts.onEditRequestStateChange = (
        s,
      ) => states.push(s);
      (v.session as unknown as { opts: CollabSessionOptions }).opts.onRoleChange = (r) =>
        roles.push(r);
      v.session.start();
      await settle(relay);
      const vId = host.session.peers[0].clientId;

      v.session.requestEdit();
      await settle(relay);
      expect(host.session.peers[0].requestedEdit).toBe(true);
      host.session.denyEdit(vId);
      await settle(relay);
      expect(host.session.peers[0].requestedEdit).toBe(false);
      expect(states).toEqual(["pending", "denied"]);

      v.session.requestEdit();
      await settle(relay);
      relay.setRole(v.transport, "editor");
      await settle(relay);
      expect(roles).toEqual(["viewer", "editor"]);
      expect(host.session.peers[0]).toMatchObject({ role: "editor", requestedEdit: false });
      expect(states[states.length - 1]).toBe("none");

      v.api.edit("a", { x: 42 });
      await settle(relay);
      expect(host.api.get("a")?.x).toBe(42);
    });

    it("keeps a promoted role across reconnects via the resume token", async () => {
      const relay = new MemoryRelay(undefined, { guestRole: "viewer" });
      makePeer(relay, { username: "H", isHost: true });
      await settle(relay);
      const v = makePeer(relay, { username: "V" });
      await settle(relay);
      relay.setRole(v.transport, "editor");
      await settle(relay);
      const again = relay.createTransport({ resumeToken: v.transport.resumeTokenForTests });
      again.connect(ROOM);
      await settle(relay);
      expect(relay.roleOf(again)).toBe("editor");
      again.close();
    });

    it("viewers never answer SYNC_REQUEST", async () => {
      const relay = new MemoryRelay(undefined, { guestRole: "viewer" });
      const v1 = makePeer(relay, { username: "V1", elements: [rect("a", "a0")] });
      await settle(relay);
      makePeer(relay, { username: "V2" });
      await settle(relay);
      expect(types(v1)).not.toContain("SCENE_INIT");
    });
  });
});
