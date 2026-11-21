// Named styles over real collab: two REAL Excalidraw editors joined by CollabSession over the
// in-memory relay, each with the production reactor (styles + components) and `remoteApi`.
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
import type { El } from "../reactor/reactor";
import { installComponents, remoteApi, uninstallComponents } from "../components/host";
import { createStyle, updateStyle } from "./actions";
import { runStyleCommand } from "./host";
import { listStyles, styleTagOf } from "./model";

type Api = ExcalidrawImperativeAPI;

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
  api: Api;
  session: CollabSession;
  sent: Payload[];
}
const live: Peer[] = [];

afterEach(async () => {
  for (const p of live.splice(0)) {
    uninstallComponents(p.api);
    await p.session.stop();
  }
  cleanup();
});

async function peer(relay: MemoryRelay, host: boolean, elements: El[] = []): Promise<Peer> {
  let api: Api | null = null;
  render(<Excalidraw excalidrawAPI={(a) => (api = a)} initialData={{ elements }} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  const ex = api as unknown as Api;
  installComponents(ex, { schedule: frameAfter(16) });
  const p = { api: ex, sent: [] as Payload[] } as Peer;
  p.session = new CollabSession({
    transport: relay.createTransport({ hostToken: host ? MEMORY_HOST_TOKEN : null }),
    roomId: ROOM,
    key: KEY,
    username: host ? "A" : "B",
    isHost: host,
    api: remoteApi(ex),
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

async function settle(relay: MemoryRelay, ms = 90) {
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
const look = (p: Peer) =>
  p.api
    .getSceneElements()
    .map(
      (e) =>
        `${e.id}:${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.width)}x${Math.round(e.height)},${e.strokeColor},${e.backgroundColor},${JSON.stringify(styleTagOf(e))}`,
    )
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

function fixture(): El[] {
  return convertToExcalidrawElements(
    [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 200, height: 80, label: { text: "Hi" } },
      { type: "ellipse", id: "E", x: 240, y: 0, width: 60, height: 60 },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
}

it("style edits and overrides on either peer reach the other once, with no echo", async () => {
  const relay = new MemoryRelay();
  const a = await peer(relay, true, fixture());
  let styleId = "";
  act(() => {
    styleId = runStyleCommand(a.api, (d) =>
      createStyle(d, ["R", "E"], "Primary", { strokeColor: "#1971c2" }),
    )!.styleId;
  });
  await settle(relay);
  const b = await peer(relay, false);
  await settle(relay);
  expect(look(b)).toEqual(look(a));
  expect(listStyles(b.api.getSceneElementsIncludingDeleted())[0].name).toBe("Primary");

  a.sent.length = 0;
  b.sent.length = 0;
  act(() => {
    runStyleCommand(a.api, (d) => updateStyle(d, styleId, { props: { strokeColor: "#e03131" } }));
  });
  await settle(relay);
  for (const id of ["R", "E"])
    expect(b.api.getSceneElements().find((e) => e.id === id)!.strokeColor).toBe("#e03131");
  expect(sceneUpdates(b)).toBe(0); // B applies A's synced elements, never re-derives
  expect(stamps(b)).toEqual(stamps(a));

  // A direct edit on B becomes an override there; A only receives it.
  a.sent.length = 0;
  edit(b, "E", { strokeColor: "#2f9e44" });
  await settle(relay);
  expect(sceneUpdates(a)).toBe(0);
  const e = a.api.getSceneElements().find((x) => x.id === "E")!;
  expect(styleTagOf(e)?.overrides).toEqual({ strokeColor: "#2f9e44" });
  expect(look(a)).toEqual(look(b));
  expect(stamps(a)).toEqual(stamps(b));
});
