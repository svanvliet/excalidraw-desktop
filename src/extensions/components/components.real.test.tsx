// Components v1 against the REAL Excalidraw 0.18.1 (Store/History, duplicate action) in jsdom.
import "../../agent/scene/testHarness";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { El } from "../reactor/reactor";
import {
  createComponent,
  insertInstance,
  resetOverrides,
  setOverrides,
  detachInstance,
} from "./actions";
import { componentsOnDuplicate } from "./duplicate";
import { installComponents, runComponentCommand, uninstallComponents } from "./host";
import { groupOf, listComponents, tagOf } from "./model";

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

const mounted: Api[] = [];
afterEach(() => {
  for (const api of mounted.splice(0)) uninstallComponents(api);
  cleanup();
});

function manualSchedule() {
  const queue: Array<() => void> = [];
  return {
    scheduled: () => queue.length,
    schedule: (cb: () => void) => {
      queue.push(cb);
      return () => {
        const i = queue.indexOf(cb);
        if (i >= 0) queue.splice(i, 1);
      };
    },
    frame: () => act(() => queue.splice(0).forEach((cb) => cb())),
  };
}

/** Labelled rectangle "R" (0,0 200×80, "Hello") and ellipse "E" at (220,20). */
function base(): El[] {
  return convertToExcalidrawElements(
    [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 200, height: 80, label: { text: "Hello" } },
      { type: "ellipse", id: "E", x: 220, y: 20, width: 40, height: 40 },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
}

async function mount(elements: El[]): Promise<Api> {
  let api: Api | null = null;
  render(
    <Excalidraw
      excalidrawAPI={(a) => (api = a)}
      initialData={{ elements }}
      onDuplicate={componentsOnDuplicate}
    />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  mounted.push(api!);
  return api as unknown as Api;
}

const all = (api: Api) => api.getSceneElementsIncludingDeleted();
const get = (api: Api, id: string) => all(api).find((e) => e.id === id)!;
const labelOf = (api: Api, containerId: string) =>
  all(api).find(
    (e) => !e.isDeleted && (e as ExcalidrawTextElement).containerId === containerId,
  ) as ExcalidrawTextElement;
/** Live child of instance `group` mirroring master slot `slot`. */
const child = (api: Api, group: string, slot: string) =>
  all(api).find((e) => {
    const t = tagOf(e);
    return !e.isDeleted && t?.role === "instance" && groupOf(e, t) === group && t.slot === slot;
  })!;
const button = (label: "Undo" | "Redo") =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const click = (label: "Undo" | "Redo") => act(() => void fireEvent.click(button(label)));
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    const el = document.querySelector(".excalidraw")!;
    fireEvent.keyDown(el, { key: k, ...init });
    fireEvent.keyUp(el, { key: k, ...init });
  });

/** A user edit (one captured history entry) to one or more elements. */
function userEdit(api: Api, patches: Record<string, Record<string, unknown>>) {
  act(() =>
    api.updateScene({
      elements: all(api).map((e) =>
        patches[e.id]
          ? { ...e, ...patches[e.id], version: e.version + 1, versionNonce: e.versionNonce + 1 }
          : e,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    }),
  );
}

function run<T>(api: Api, fn: Parameters<typeof runComponentCommand<T>>[1]): T {
  let out: T | null = null;
  act(() => {
    out = runComponentCommand(api, fn);
  });
  expect(out).not.toBeNull();
  return out!;
}

async function setup(elements: El[] = base()) {
  const api = await mount(elements);
  const clock = manualSchedule();
  const reactor = installComponents(api, { schedule: clock.schedule });
  const created = run(api, (d) => createComponent(d, ["R", "E"], "Card"));
  const text = labelOf(api, "R").id;
  const inst = run(api, (d) => insertInstance(d, created.componentId, { x: 0, y: 300 }));
  clock.frame();
  return { api, clock, reactor, created, text, inst };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe("create + insert", () => {
  it("tags the master, builds a synced instance, one undo step each", async () => {
    const { api, created, text, inst, reactor } = await setup();
    expect(created.ids.sort()).toEqual(["E", "R", text].sort());
    for (const id of created.ids)
      expect(tagOf(get(api, id))).toMatchObject({ role: "master", slot: id, name: "Card" });
    expect(inst.ids).toHaveLength(3);
    expect(child(api, inst.groupId, "R")).toMatchObject({ x: 0, y: 300, width: 200, height: 80 });
    expect(child(api, inst.groupId, "E")).toMatchObject({ x: 220, y: 320 });
    const label = child(api, inst.groupId, text) as ExcalidrawTextElement;
    expect(label.originalText).toBe("Hello");
    expect(label.containerId).toBe(child(api, inst.groupId, "R").id);
    expect(child(api, inst.groupId, "R").boundElements).toEqual([{ id: label.id, type: "text" }]);
    // The actions left nothing for the live sync to do.
    expect(reactor.stats.patched).toBe(0);
    const [info] = listComponents(all(api));
    expect(info).toMatchObject({ name: "Card", masterGroupId: created.masterGroupId });
    expect(info.instances).toEqual([
      { groupId: inst.groupId, ids: expect.any(Array), overriddenSlots: 0 },
    ]);

    click("Undo");
    expect(all(api).filter((e) => !e.isDeleted)).toHaveLength(3);
    click("Undo");
    expect(tagOf(get(api, "R"))).toBeNull();
    expect(get(api, "R").groupIds).toEqual([]);
    expect(button("Undo").disabled).toBe(true);
  });
});

describe("live sync master → instances", () => {
  it("geometry, style and text follow; one undo reverts master and instances", async () => {
    const { api, clock, inst, text } = await setup();
    userEdit(api, { R: { width: 300, backgroundColor: "#ffc9c9" }, E: { x: 330 } });
    clock.frame();
    expect(child(api, inst.groupId, "R")).toMatchObject({
      x: 0,
      y: 300,
      width: 300,
      backgroundColor: "#ffc9c9",
    });
    expect(child(api, inst.groupId, "E")).toMatchObject({ x: 330, y: 320 });

    userEdit(api, { [text]: { text: "Hello world", originalText: "Hello world" } });
    clock.frame();
    const label = child(api, inst.groupId, text) as ExcalidrawTextElement;
    expect(label.originalText).toBe("Hello world");
    // Re-measured inside the instance's container, not copied.
    expect(label.width).toBeGreaterThan(0);
    expect(near(label.x + label.width / 2, 150)).toBe(true);

    click("Undo");
    clock.frame();
    expect((child(api, inst.groupId, text) as ExcalidrawTextElement).originalText).toBe("Hello");
    click("Undo");
    clock.frame();
    expect(get(api, "R").width).toBe(200);
    expect(child(api, inst.groupId, "R")).toMatchObject({
      width: 200,
      backgroundColor: get(api, "R").backgroundColor,
    });
    expect(child(api, inst.groupId, "E")).toMatchObject({ x: 220, y: 320 });
    // Redo stays available: the sync writes never became history entries.
    expect(button("Redo").disabled).toBe(false);
    click("Redo");
    clock.frame();
    expect(child(api, inst.groupId, "R").width).toBe(300);
  });

  it("re-derives under a scaled + rotated instance transform", async () => {
    const { api, clock, created, text } = await setup();
    const rot = run(api, (d) =>
      insertInstance(d, created.componentId, { x: 600, y: 0, scale: 2, angle: Math.PI / 2 }),
    );
    clock.frame();
    const r = child(api, rot.groupId, "R");
    expect(r).toMatchObject({ x: 320, y: 120, width: 400, height: 160 });
    expect(near(r.angle, Math.PI / 2)).toBe(true);
    expect((child(api, rot.groupId, text) as ExcalidrawTextElement).fontSize).toBe(40);

    userEdit(api, { R: { width: 300 } });
    clock.frame();
    // base R: centre (150,40) → scaled (300,80) → rotated 90° (-80,300) → centre (520,300).
    const r2 = child(api, rot.groupId, "R");
    expect(r2.width).toBe(600);
    expect(near(r2.x + r2.width / 2, 520)).toBe(true);
    expect(near(r2.y + r2.height / 2, 300)).toBe(true);

    // Moving the whole instance keeps its transform: edit the master again.
    const ids = all(api)
      .filter((e) => groupOf(e, tagOf(e)) === rot.groupId)
      .map((e) => e.id);
    userEdit(api, Object.fromEntries(ids.map((id) => [id, { x: get(api, id).x + 50 }])));
    clock.frame();
    userEdit(api, { E: { backgroundColor: "#a5d8ff" } });
    clock.frame();
    const e = child(api, rot.groupId, "E");
    expect(e.backgroundColor).toBe("#a5d8ff");
    // E base centre (240,40) → scaled (480,80) → rotated (-80,480) + origin (650,0).
    expect(near(e.x + e.width / 2, 570)).toBe(true);
    expect(near(e.y + e.height / 2, 480)).toBe(true);
  });

  it("adds and removes instance children with the master", async () => {
    const { api, clock, inst, created } = await setup();
    const [dot] = convertToExcalidrawElements(
      [
        { type: "diamond", id: "D", x: 0, y: 100, width: 30, height: 30 },
      ] as ExcalidrawElementSkeleton[],
      { regenerateIds: false },
    );
    act(() =>
      api.updateScene({
        elements: [...all(api), { ...dot, groupIds: [created.masterGroupId] }],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    clock.frame();
    expect(tagOf(get(api, "D"))).toMatchObject({ role: "master", slot: "D" });
    expect(child(api, inst.groupId, "D")).toMatchObject({ x: 0, y: 400, type: "diamond" });

    userEdit(api, { E: { isDeleted: true } });
    clock.frame();
    expect(child(api, inst.groupId, "E")).toBeUndefined();
    click("Undo");
    clock.frame();
    expect(child(api, inst.groupId, "E")).toMatchObject({ x: 220, y: 320 });
  });
});

describe("overrides", () => {
  it("direct edits become overrides; reset and detach", async () => {
    const { api, clock, inst, created, text } = await setup();
    const other = run(api, (d) => insertInstance(d, created.componentId, { x: 0, y: 600 }));
    const r = child(api, inst.groupId, "R");
    const label = child(api, inst.groupId, text);
    userEdit(api, {
      [r.id]: { backgroundColor: "#b2f2bb", x: r.x + 999 },
      [label.id]: { text: "Bye", originalText: "Bye" },
    });
    clock.frame();
    expect(tagOf(child(api, inst.groupId, "R"))?.overrides).toEqual({ backgroundColor: "#b2f2bb" });
    expect(tagOf(child(api, inst.groupId, text))?.overrides).toEqual({ text: "Bye" });

    userEdit(api, {
      R: { backgroundColor: "#ffec99" },
      [text]: { text: "Hi", originalText: "Hi" },
    });
    clock.frame();
    expect(child(api, inst.groupId, "R").backgroundColor).toBe("#b2f2bb");
    expect((child(api, inst.groupId, text) as ExcalidrawTextElement).originalText).toBe("Bye");
    expect(child(api, other.groupId, "R").backgroundColor).toBe("#ffec99");
    expect((child(api, other.groupId, text) as ExcalidrawTextElement).originalText).toBe("Hi");

    run(api, (d) => setOverrides(d, inst.groupId, [{ slot: "E", values: { opacity: 40 } }]));
    clock.frame();
    expect(child(api, inst.groupId, "E").opacity).toBe(40);

    run(api, (d) => resetOverrides(d, inst.groupId, { slots: ["R"] }));
    expect(child(api, inst.groupId, "R").backgroundColor).toBe("#ffec99");
    expect(tagOf(child(api, inst.groupId, text))?.overrides).toEqual({ text: "Bye" });
    click("Undo");
    clock.frame();
    expect(child(api, inst.groupId, "R").backgroundColor).toBe("#b2f2bb");

    run(api, (d) => detachInstance(d, inst.groupId));
    clock.frame();
    const detached = get(api, r.id);
    expect(tagOf(detached)).toBeNull();
    expect(detached.groupIds).toContain(inst.groupId);
    userEdit(api, { R: { backgroundColor: "#d0bfff" } });
    clock.frame();
    expect(get(api, r.id).backgroundColor).toBe("#b2f2bb");
    click("Undo");
    click("Undo");
    clock.frame();
    expect(tagOf(get(api, r.id))?.role).toBe("instance");
  });

  it("an action on a sync-patched element is its own undo step (mutate keeps the snapshot current)", async () => {
    const { api, clock, inst } = await setup();
    const r = child(api, inst.groupId, "R");
    userEdit(api, { [r.id]: { backgroundColor: "#b2f2bb" } });
    clock.frame(); // the sync writes the override tag in place
    run(api, (d) => resetOverrides(d, inst.groupId));
    expect(get(api, r.id).backgroundColor).toBe(get(api, "R").backgroundColor);
    click("Undo");
    expect(get(api, r.id).backgroundColor).toBe("#b2f2bb");
    expect(tagOf(get(api, r.id))?.overrides).toEqual({ backgroundColor: "#b2f2bb" });
  });

  it("undoing an adopted edit clears the override", async () => {
    const { api, clock, inst, text } = await setup();
    const label = child(api, inst.groupId, text);
    userEdit(api, { [label.id]: { text: "Bye", originalText: "Bye" } });
    clock.frame();
    expect(tagOf(get(api, label.id))?.overrides).toEqual({ text: "Bye" });
    click("Undo");
    clock.frame();
    expect(tagOf(get(api, label.id))?.overrides).toBeUndefined();
    expect((get(api, label.id) as ExcalidrawTextElement).originalText).toBe("Hello");
  });
});

describe("orphans and duplicates", () => {
  it("deleting the master promotes an instance; undo demotes it again", async () => {
    const { api, clock, inst, created, text } = await setup();
    const r = child(api, inst.groupId, "R");
    userEdit(api, { [r.id]: { backgroundColor: "#b2f2bb" } });
    clock.frame();
    userEdit(api, Object.fromEntries(created.ids.map((id) => [id, { isDeleted: true }])));
    clock.frame();
    const promoted = tagOf(get(api, r.id))!;
    expect(promoted.role).toBe("master");
    expect(promoted.promoted).toEqual({
      overrides: { backgroundColor: "#b2f2bb" },
      base: expect.any(Object),
    });
    expect(listComponents(all(api))[0].masterGroupId).toBe(inst.groupId);
    expect(get(api, r.id).backgroundColor).toBe("#b2f2bb");

    click("Undo");
    clock.frame();
    expect(tagOf(get(api, "R"))?.role).toBe("master");
    expect(tagOf(get(api, r.id))).toMatchObject({
      role: "instance",
      overrides: { backgroundColor: "#b2f2bb" },
    });
    userEdit(api, { [text]: { text: "Back", originalText: "Back" } });
    clock.frame();
    expect((child(api, inst.groupId, text) as ExcalidrawTextElement).originalText).toBe("Back");
  });

  it("Ctrl/Cmd+D on the master makes an instance in the same undo step", async () => {
    const { api, clock, created, inst } = await setup();
    act(() =>
      api.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(created.ids.map((id) => [id, true])),
          selectedGroupIds: { [created.masterGroupId]: true },
        } as never,
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    key("d", { ctrlKey: true });
    clock.frame();
    const comps = listComponents(all(api));
    expect(comps).toHaveLength(1);
    expect(comps[0].masterGroupId).toBe(created.masterGroupId);
    expect(comps[0].instances).toHaveLength(2);
    const dup = comps[0].instances.find((i) => i.groupId !== inst.groupId)!;
    expect(dup.ids).toHaveLength(3);
    userEdit(api, { R: { backgroundColor: "#ffc9c9" } });
    clock.frame();
    expect(child(api, dup.groupId, "R").backgroundColor).toBe("#ffc9c9");
    click("Undo");
    click("Undo");
    clock.frame();
    expect(listComponents(all(api))[0].instances).toHaveLength(1);
  });

  it("Alt-drag swaps roles: the stationary copy stays the master", () => {
    const els = base();
    const tagged = els.map((e) => ({
      ...e,
      groupIds: ["M"],
      customData: {
        "excalidrawDesktop.component": {
          v: 1,
          role: "master",
          componentId: "c",
          slot: e.id,
          gi: 0,
        },
      },
    })) as El[];
    const copies = tagged.map((e) => ({ ...e, id: `${e.id}-copy`, groupIds: ["M2"] })) as El[];
    const out = componentsOnDuplicate([...tagged, ...copies], tagged)!;
    for (const e of out) {
      const t = tagOf(e)!;
      expect(t.role).toBe(e.id.endsWith("-copy") ? "master" : "instance");
      if (t.role === "instance") expect(t.base).toBeDefined();
    }
    // A moved copy (paste / Ctrl+D) becomes the instance instead.
    const moved = copies.map((e) => ({ ...e, x: e.x + 10 })) as El[];
    for (const e of componentsOnDuplicate([...tagged, ...moved], tagged)!)
      expect(tagOf(e)!.role).toBe(e.id.endsWith("-copy") ? "instance" : "master");
  });
});

describe("persistence", () => {
  it("survives save + reload and keeps syncing", async () => {
    const { api, inst } = await setup();
    const saved = JSON.parse(JSON.stringify(all(api)));
    cleanup();
    const reloaded = restoreElements(saved, null) as El[];
    const api2 = await mount(reloaded);
    const clock = manualSchedule();
    installComponents(api2, { schedule: clock.schedule });
    userEdit(api2, { E: { y: 40 } });
    clock.frame();
    expect(child(api2, inst.groupId, "E")).toMatchObject({ x: 220, y: 340 });
  });
});
