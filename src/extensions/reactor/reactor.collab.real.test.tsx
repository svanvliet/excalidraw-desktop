// Reactor spike, point 3: two REAL Excalidraw instances joined by the real CollabSession over the
// in-memory relay. Only the editing peer derives; the other converges without echo.
import "../../agent/scene/testHarness";
import { afterEach, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { CollabSession, type CollabTiming } from "../../collab/CollabSession";
import { MEMORY_HOST_TOKEN, MemoryRelay } from "../../collab/memoryRelay";
import type { Payload } from "../../collab/protocol";
import { createReactor, type El, type Reactor } from "./reactor";
import { mirrorRule, withMirrorLink } from "./mirrorRule";

const g = globalThis as Record<string, unknown>;
g.Path2D ??= class {
  addPath() {}
};
g.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(document as unknown as { fonts: { has?: () => boolean } }).fonts.has ??= () => true;

const ROOM = "0123456789abcdef0123";
const KEY = "AAAAAAAAAAAAAAAAAAAAAA";
const FAST: Partial<CollabTiming> = {
  sceneThrottleMs: 5,
  pointerThrottleMs: 20,
  antiEntropyMs: 1_000_000,
  idleAfterMs: 1_000_000,
};
const frameAfter = (ms: number) => (cb: () => void) => {
  const id = setTimeout(cb, ms);
  return () => clearTimeout(id);
};

interface Peer {
  api: ExcalidrawImperativeAPI;
  session: CollabSession;
  reactor: Reactor;
  sent: Payload[];
}
const live: Peer[] = [];

afterEach(async () => {
  for (const p of live.splice(0)) {
    p.reactor.dispose();
    await p.session.stop();
  }
  cleanup();
});

function fixture(): El[] {
  const els = convertToExcalidrawElements(
    [
      { type: "rectangle", id: "S", x: 0, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "T1", x: 0, y: 200, width: 100, height: 60 },
      { type: "rectangle", id: "T2", x: 300, y: 0, width: 100, height: 60 },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
  return [
    withMirrorLink(els[0], { role: "source", key: "k" }),
    withMirrorLink(els[1], { role: "target", key: "k", dx: 0, dy: 200 }),
    withMirrorLink(els[2], { role: "target", key: "k", dx: 300, dy: 0 }),
  ];
}

async function peer(
  relay: MemoryRelay,
  opts: { host?: boolean; elements?: El[]; tagRemote: boolean; frameMs?: number },
): Promise<Peer> {
  let api: ExcalidrawImperativeAPI | null = null;
  render(
    <Excalidraw excalidrawAPI={(a) => (api = a)} initialData={{ elements: opts.elements ?? [] }} />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  const ex = api as unknown as ExcalidrawImperativeAPI;
  const reactor = createReactor({
    api: ex,
    rules: [mirrorRule],
    schedule: frameAfter(opts.frameMs ?? 16),
    apply: process.env.REACTOR_APPLY === "mutate" ? "mutate" : "replace",
  });
  const p = { api: ex, reactor, sent: [] as Payload[] } as Peer;
  p.session = new CollabSession({
    transport: relay.createTransport({ hostToken: opts.host ? MEMORY_HOST_TOKEN : null }),
    roomId: ROOM,
    key: KEY,
    username: opts.host ? "A" : "B",
    isHost: !!opts.host,
    // The only integration point: collab applies go through the reactor's tagging proxy.
    api: opts.tagRemote ? reactor.wrapRemoteApi(ex) : ex,
    timing: FAST,
  });
  const session = p.session as unknown as { send: (m: Payload, v?: boolean) => void };
  const send = session.send.bind(p.session);
  session.send = (m, v) => {
    p.sent.push(m);
    send(m, v);
  };
  ex.onChange((els) =>
    p.session.onSceneChange(els as Parameters<CollabSession["onSceneChange"]>[0]),
  );
  p.session.start();
  live.push(p);
  return p;
}

async function settle(relay: MemoryRelay, ms = 80) {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await relay.flush();
      await new Promise((r) => setTimeout(r, ms / 3));
    });
  }
  await act(async () => {
    await relay.flush();
  });
}

const sceneUpdates = (p: Peer) => p.sent.filter((m) => m.type === "SCENE_UPDATE").length;
const geom = (p: Peer) =>
  p.api
    .getSceneElements()
    .map((e) => `${e.id}:${e.x},${e.y},${e.width}x${e.height},${e.backgroundColor}`)
    .sort();
const stamps = (p: Peer) =>
  p.api
    .getSceneElementsIncludingDeleted()
    .map((e) => `${e.id}@${e.version}:${e.versionNonce}`)
    .sort();

function edit(p: Peer, id: string, patch: Record<string, unknown>) {
  act(() =>
    p.api.updateScene({
      elements: p.api
        .getSceneElementsIncludingDeleted()
        .map((e) =>
          e.id === id
            ? { ...e, ...patch, version: e.version + 1, versionNonce: e.versionNonce + 7 }
            : e,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    }),
  );
}

it("only the editing peer derives; both converge with no echo (tagged applies)", async () => {
  const relay = new MemoryRelay();
  const a = await peer(relay, { host: true, elements: fixture(), tagRemote: true });
  await settle(relay);
  const b = await peer(relay, { tagRemote: true });
  await settle(relay);
  expect(geom(b)).toEqual(geom(a));
  expect(b.reactor.stats.patched).toBe(0); // SCENE_INIT wasn't treated as a local edit

  for (const [i, patch] of [{ x: 40 }, { backgroundColor: "#b2f2bb" }, { width: 160 }].entries()) {
    a.sent.length = 0;
    b.sent.length = 0;
    edit(a, "S", patch);
    await settle(relay);
    expect(a.reactor.stats.patched).toBe(2 * (i + 1));
    expect(b.reactor.stats.patched).toBe(0); // B never derives …
    expect(sceneUpdates(b)).toBe(0); // … and never re-broadcasts what it received
    expect(sceneUpdates(a)).toBeGreaterThanOrEqual(1);
    expect(sceneUpdates(a)).toBeLessThanOrEqual(2); // source, then derived targets
    expect(geom(b)).toEqual(geom(a));
    expect(stamps(b)).toEqual(stamps(a)); // identical versions: no divergent re-derivation
  }

  // B edits now: B propagates, A only receives.
  a.sent.length = 0;
  edit(b, "S", { y: 30 });
  await settle(relay);
  expect(b.reactor.stats.patched).toBe(2);
  expect(sceneUpdates(a)).toBe(0);
  expect(geom(a)).toEqual(geom(b));
  expect(a.api.getSceneElements().find((e) => e.id === "T1")).toMatchObject({ x: 40, y: 230 });

  // Quiescent: no further traffic.
  a.sent.length = 0;
  b.sent.length = 0;
  await settle(relay, 150);
  expect(sceneUpdates(a) + sceneUpdates(b)).toBe(0);
});

it("an untagged peer still converges via idempotency, at the cost of duplicate writes", async () => {
  const relay = new MemoryRelay();
  // Worst case: B derives before A's derived targets arrive.
  const a = await peer(relay, { host: true, elements: fixture(), tagRemote: true, frameMs: 60 });
  await settle(relay);
  const b = await peer(relay, { tagRemote: false, frameMs: 1 });
  await settle(relay);
  a.sent.length = 0;
  b.sent.length = 0;
  edit(a, "S", { x: 40 });
  await settle(relay, 200);
  expect(geom(b)).toEqual(geom(a));
  expect(stamps(b)).toEqual(stamps(a));
  // Without tagging, B treats the remote source change as local and re-derives it (duplicate
  // writes; depending on timing both peers broadcast competing — but equal — target versions).
  expect(b.reactor.stats.patched).toBe(2);
  // Quiescent afterwards: no loop.
  a.sent.length = 0;
  b.sent.length = 0;
  await settle(relay, 150);
  expect(sceneUpdates(a) + sceneUpdates(b)).toBe(0);
});
