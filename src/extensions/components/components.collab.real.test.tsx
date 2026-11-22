// Components v1 over real collab: two REAL Excalidraw editors joined by CollabSession over the
// in-memory relay, each with the production components engine and `remoteApi` tagging.
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
import {
  createComponent,
  defineProperty,
  insertInstance,
  instanceProperties,
  setOverrides,
  setProperties,
} from "./actions";
import { demoteMaster, masterSnapshot, withMaster } from "./library";
import {
  applyComponentMasterEdit,
  dematerializeMaster,
  installComponents,
  materializeMaster,
  remoteApi,
  runComponentCommand,
  uninstallComponents,
} from "./host";
import { tagOf } from "./model";

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
        `${e.id}:${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.width)}x${Math.round(e.height)},${e.backgroundColor},${"text" in e ? e.text : ""}`,
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
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
}

it("master edits on either peer reach both instances once, with no echo", async () => {
  const relay = new MemoryRelay();
  const a = await peer(relay, true, fixture());
  let instRect = "";
  act(() => {
    runComponentCommand(a.api, (d) => {
      const { componentId } = createComponent(d, ["R"]);
      const out = insertInstance(d, componentId, { x: 400, y: 0, scale: 2 });
      instRect = out.ids.find((id) => d.get(id)!.type === "rectangle")!;
    });
  });
  await settle(relay);
  const b = await peer(relay, false);
  await settle(relay);
  expect(look(b)).toEqual(look(a));
  expect(b.api.getSceneElements().filter((e) => tagOf(e))).toHaveLength(4);

  a.sent.length = 0;
  b.sent.length = 0;
  edit(a, "R", { backgroundColor: "#a5d8ff", width: 240 });
  await settle(relay);
  const inst = () => b.api.getSceneElements().find((e) => e.id === instRect)!;
  expect(inst()).toMatchObject({ backgroundColor: "#a5d8ff", width: 480, x: 400 });
  expect(sceneUpdates(b)).toBe(0); // B applies A's master + instance updates, never re-derives
  expect(look(b)).toEqual(look(a));
  expect(stamps(b)).toEqual(stamps(a));

  // Now B edits the master text; A only receives.
  a.sent.length = 0;
  const label = b.api
    .getSceneElements()
    .find((e) => e.type === "text" && tagOf(e)?.role === "master")!;
  edit(b, label.id, { text: "Hello there", originalText: "Hello there" });
  await settle(relay);
  expect(sceneUpdates(a)).toBe(0);
  expect(look(a)).toEqual(look(b));
  const instText = a.api
    .getSceneElements()
    .find((e) => e.type === "text" && tagOf(e)?.role === "instance")!;
  expect("text" in instText && instText.text).toBe("Hello there");

  // An override set on B survives a later master edit on A.
  act(() => {
    runComponentCommand(b.api, (d) =>
      setOverrides(d, instRect, [{ elementId: instRect, values: { backgroundColor: "#ffec99" } }]),
    );
  });
  await settle(relay);
  edit(a, "R", { backgroundColor: "#b2f2bb", height: 100 });
  await settle(relay);
  for (const p of [a, b])
    expect(p.api.getSceneElements().find((e) => e.id === instRect)).toMatchObject({
      backgroundColor: "#ffec99",
      height: 200,
    });
  expect(look(a)).toEqual(look(b));
  expect(stamps(a)).toEqual(stamps(b));

  a.sent.length = 0;
  b.sent.length = 0;
  await settle(relay, 150);
  expect(sceneUpdates(a) + sceneUpdates(b)).toBe(0);
});

it("library masters: dematerialize/materialize on A reach B without promotion or echo", async () => {
  const relay = new MemoryRelay();
  const a = await peer(relay, true, fixture());
  let master = "";
  let instGroup = "";
  let instRect = "";
  act(() => {
    runComponentCommand(a.api, (d) => {
      const c = createComponent(d, ["R"]);
      master = c.masterGroupId;
      const out = insertInstance(d, c.componentId, { x: 400, y: 0 });
      instGroup = out.groupId;
      instRect = out.ids.find((id) => d.get(id)!.type === "rectangle")!;
    });
  });
  await settle(relay);
  const b = await peer(relay, false);
  await settle(relay);

  a.sent.length = 0;
  b.sent.length = 0;
  act(() => {
    expect(dematerializeMaster(a.api, master)).not.toBeNull();
  });
  await settle(relay);
  expect(sceneUpdates(b)).toBe(0);
  for (const p of [a, b]) {
    const tagged = p.api.getSceneElements().filter((e) => tagOf(e));
    expect(tagged).toHaveLength(2);
    for (const e of tagged) expect(tagOf(e)).toMatchObject({ role: "instance", source: "library" });
  }
  expect(look(b)).toEqual(look(a));
  expect(stamps(b)).toEqual(stamps(a));

  a.sent.length = 0;
  let group: string | null = null;
  act(() => {
    group = materializeMaster(a.api, instGroup);
  });
  expect(group).not.toBeNull();
  await settle(relay);
  expect(sceneUpdates(b)).toBe(0);
  expect(look(b)).toEqual(look(a));

  // The materialized master syncs as usual from either peer.
  b.sent.length = 0;
  const m = a.api
    .getSceneElements()
    .find((e) => e.type === "rectangle" && tagOf(e)?.role === "master")!;
  edit(a, m.id, { backgroundColor: "#a5d8ff" });
  await settle(relay);
  expect(b.api.getSceneElements().find((e) => e.id === instRect)).toMatchObject({
    backgroundColor: "#a5d8ff",
  });
  expect(sceneUpdates(b)).toBe(0);
  expect(stamps(b)).toEqual(stamps(a));
});

it("a masterless master edit (Done) sends one update and B applies it with no echo", async () => {
  const relay = new MemoryRelay();
  const a = await peer(relay, true, fixture());
  let cid = "";
  act(() => {
    runComponentCommand(a.api, (d) => {
      const c = createComponent(d, ["R"]);
      cid = c.componentId;
      demoteMaster(d, c.masterGroupId);
      withMaster(d, cid, () => insertInstance(d, cid, { x: 400, y: 0 }));
    });
  });
  await settle(relay);
  const b = await peer(relay, false);
  await settle(relay);
  const rects = (p: Peer) =>
    p.api.getSceneElements().filter((e) => e.type === "rectangle" && tagOf(e));
  expect(rects(b)).toHaveLength(2);

  a.sent.length = 0;
  b.sent.length = 0;
  const snap = masterSnapshot(a.api.getSceneElements() as readonly El[], cid);
  const edited = snap.elements.map((e) =>
    e.type === "rectangle" ? { ...e, backgroundColor: "#ffc9c9", height: 120 } : e,
  );
  let ok = false;
  act(() => {
    ok = applyComponentMasterEdit(a.api, cid, edited);
  });
  expect(ok).toBe(true);
  await settle(relay, 150);
  expect(sceneUpdates(a)).toBe(1);
  expect(sceneUpdates(b)).toBe(0);
  for (const p of [a, b]) {
    expect(rects(p)).toHaveLength(2);
    for (const r of rects(p)) {
      expect(r).toMatchObject({ backgroundColor: "#ffc9c9", height: 120 });
      expect(tagOf(r)).toMatchObject({ role: "instance", source: "library" });
    }
    expect(p.api.getSceneElements().some((e) => tagOf(e)?.role === "master")).toBe(false);
  }
  expect(look(b)).toEqual(look(a));
  expect(stamps(b)).toEqual(stamps(a));
});

it("property values and nested components sync across peers with no echo", async () => {
  const relay = new MemoryRelay();
  const a = await peer(relay, true, fixture());
  let outer = "";
  let nestedKey = "";
  act(() => {
    runComponentCommand(a.api, (d) => {
      const card = createComponent(d, ["R"], "Card");
      defineProperty(d, card.componentId, {
        name: "Title",
        type: "text",
        bindings: [{ elementId: "R" }],
      });
      const inner = insertInstance(d, card.componentId, { x: 0, y: 200 });
      const panel = createComponent(d, inner.ids, "Panel");
      outer = insertInstance(d, panel.componentId, { x: 400, y: 200 }).groupId;
    });
  });
  await settle(relay);
  const b = await peer(relay, false);
  await settle(relay);
  expect(look(b)).toEqual(look(a));

  // B sets the nested Card's Title from the outer Panel instance; A only receives.
  a.sent.length = 0;
  act(() => {
    runComponentCommand(b.api, (d) => {
      nestedKey = instanceProperties(d, outer).find((t) => t.nestedKey)!.nestedKey!;
      setProperties(d, outer, { Title: "Nested" }, { nested: nestedKey });
    });
  });
  await settle(relay);
  expect(sceneUpdates(a)).toBe(0);
  const texts = (p: Peer) =>
    p.api
      .getSceneElements()
      .filter((e) => e.type === "text")
      .map((e) => ("text" in e ? e.text : ""))
      .sort();
  expect(texts(a)).toEqual(["Hi", "Hi", "Nested"]);
  expect(look(a)).toEqual(look(b));

  // A edits the Card master: both nested levels follow, the value survives, B never re-derives.
  b.sent.length = 0;
  edit(a, "R", { backgroundColor: "#a5d8ff" });
  await settle(relay);
  expect(sceneUpdates(b)).toBe(0);
  for (const p of [a, b]) {
    expect(texts(p)).toEqual(["Hi", "Hi", "Nested"]);
    const fills = p.api
      .getSceneElements()
      .filter((e) => e.type === "rectangle")
      .map((e) => e.backgroundColor);
    expect(fills).toEqual(["#a5d8ff", "#a5d8ff", "#a5d8ff"]);
  }
  expect(look(b)).toEqual(look(a));
  expect(stamps(b)).toEqual(stamps(a));

  a.sent.length = 0;
  b.sent.length = 0;
  await settle(relay, 150);
  expect(sceneUpdates(a) + sceneUpdates(b)).toBe(0);
});
