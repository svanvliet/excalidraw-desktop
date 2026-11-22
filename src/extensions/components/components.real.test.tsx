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
  defineProperty,
  insertInstance,
  instanceProperties,
  removeProperty,
  resetOverrides,
  setOverrides,
  setProperties,
  detachInstance,
  resolveInstance,
} from "./actions";
import { componentsOnDuplicate } from "./duplicate";
import {
  adoptInstanceAsMaster,
  applyComponentMasterEdit,
  createComponentFromSelection,
  defineComponentProperty,
  dematerializeMaster,
  demoteLegacyMasters,
  demoteMastersIn,
  insertComponentInstance,
  installComponents,
  materializeMaster,
  resetInstanceOverrides,
  runComponentCommand,
  setInstanceOverrides,
  setInstanceProperties,
  uninstallComponents,
} from "./host";
import { masterSnapshot } from "./library";
import { groupOf, listComponents, tagFor, tagOf, tagsOf, withTag } from "./model";
import type { Draft } from "../../agent/scene/draft";

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
const tagsOfIds = (api: Api, id: string) =>
  tagsOf(get(api, id)).map((t) => `${t.componentId}:${t.role}`);
const resolveFor = (d: Draft, ref: string) => resolveInstance(d, ref).groupId;

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
    // Real Alt-drag: the originals have already moved and sit after the copies in z-order.
    const dragged = tagged.map((e) => ({ ...e, x: e.x + 30, y: e.y + 40 })) as El[];
    for (const e of componentsOnDuplicate([...copies, ...dragged], dragged)!)
      expect(tagOf(e)!.role).toBe(e.id.endsWith("-copy") ? "master" : "instance");
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

describe("library-backed masters", () => {
  const masterIds = (api: Api, cid: string) =>
    all(api)
      .filter((e) => !e.isDeleted && tagFor(e, cid)?.role === "master")
      .map((e) => e.id);
  const call = <T,>(fn: () => T): T => {
    let out: T | undefined;
    act(() => {
      out = fn();
    });
    return out as T;
  };

  it("dematerialize tags every instance and never promotes the orphans", async () => {
    const { api, clock, created, inst, reactor } = await setup();
    const cid = created.componentId;
    const r = child(api, inst.groupId, "R");
    userEdit(api, { [r.id]: { backgroundColor: "#b2f2bb" } });
    clock.frame();
    const def = call(() => dematerializeMaster(api, created.masterGroupId))!;
    expect(def).toMatchObject({ componentId: cid, libraryId: cid, name: "Card", files: [] });
    expect(def.elements.map((e) => e.id).sort()).toEqual([...created.ids].sort());
    expect(masterIds(api, cid)).toEqual([]);
    for (const e of all(api).filter((e) => !e.isDeleted))
      expect(tagFor(e, cid)).toMatchObject({ role: "instance", source: "library", libraryId: cid });
    // The instance records the master values it overrides, to rebuild the master later.
    expect(tagOf(get(api, r.id))!.mv).toMatchObject({
      backgroundColor: get(api, "R").backgroundColor,
    });
    clock.frame();
    reactor.flush();
    expect(tagOf(get(api, r.id))?.role).toBe("instance");
    expect(listComponents(all(api))[0].masterGroupId).toBeNull();
    // Deleting the instance's sibling or editing it never promotes either.
    userEdit(api, { [r.id]: { backgroundColor: "#ffc9c9" } });
    clock.frame();
    expect(tagOf(get(api, r.id))).toMatchObject({
      role: "instance",
      overrides: { backgroundColor: "#ffc9c9" },
    });
    // One undo restores the master and the instance's untagged state.
    click("Undo");
    click("Undo");
    clock.frame();
    expect(masterIds(api, cid).sort()).toEqual([...created.ids].sort());
    expect(tagOf(get(api, r.id))!.source).toBeUndefined();
  });

  it("the UI's insert-from-library sequence (place, insert, delete, tag) stays an instance", async () => {
    const api = await mount(base());
    const clock = manualSchedule();
    installComponents(api, { schedule: clock.schedule });
    const out = run(api, (d) => {
      const c = createComponent(d, ["R", "E"], "Card");
      const ins = insertInstance(d, c.componentId, { x: 0, y: 300 });
      for (const id of c.ids) d.update(id, { isDeleted: true });
      for (const id of ins.ids) {
        const el = d.get(id)!;
        d.update(id, {
          customData: withTag(el, {
            ...tagFor(el, c.componentId)!,
            source: "library",
            libraryId: c.componentId,
          }),
        });
      }
      return { cid: c.componentId, ...ins };
    });
    clock.frame();
    for (const id of out.ids) expect(tagFor(get(api, id), out.cid)?.role).toBe("instance");
    expect(listComponents(all(api))[0]).toMatchObject({ masterGroupId: null });
  });

  it("materialize → edit → dematerialize round trip, each one undo step", async () => {
    const { api, clock, created, inst, text } = await setup();
    const cid = created.componentId;
    const r = child(api, inst.groupId, "R");
    userEdit(api, { [r.id]: { backgroundColor: "#b2f2bb" } });
    clock.frame();
    const masterBg = get(api, "R").backgroundColor;
    call(() => dematerializeMaster(api, created.masterGroupId));
    clock.frame();

    const group = call(() => materializeMaster(api, inst.groupId))!;
    clock.frame();
    const ids = masterIds(api, cid);
    expect(ids).toHaveLength(3);
    const rect = all(api).find((e) => ids.includes(e.id) && e.type === "rectangle")!;
    expect(rect).toMatchObject({ width: 200, height: 80, backgroundColor: masterBg, y: 300 });
    expect(rect.x).toBeGreaterThan(200);
    expect(groupOf(rect, tagFor(rect, cid))).toBe(group);
    expect(tagFor(rect, cid)).toMatchObject({ role: "master", source: "library" });
    const label = labelOf(api, rect.id);
    expect(label.originalText).toBe("Hello");
    expect(child(api, inst.groupId, "R").backgroundColor).toBe("#b2f2bb");

    userEdit(api, { [rect.id]: { width: 260 }, [label.id]: { text: "Hi", originalText: "Hi" } });
    clock.frame();
    expect(child(api, inst.groupId, "R")).toMatchObject({ width: 260, backgroundColor: "#b2f2bb" });
    expect((child(api, inst.groupId, text) as ExcalidrawTextElement).originalText).toBe("Hi");

    const def = call(() => dematerializeMaster(api, group))!;
    clock.frame();
    expect(def.elements.find((e) => e.type === "rectangle")).toMatchObject({ width: 260 });
    expect(masterIds(api, cid)).toEqual([]);
    expect(child(api, inst.groupId, "R")).toMatchObject({ width: 260, backgroundColor: "#b2f2bb" });

    click("Undo"); // dematerialize
    clock.frame();
    expect(masterIds(api, cid).sort()).toEqual([...ids].sort());
    click("Undo"); // edit
    clock.frame();
    expect(child(api, inst.groupId, "R").width).toBe(200);
    click("Undo"); // materialize
    clock.frame();
    expect(masterIds(api, cid)).toEqual([]);
    expect(child(api, inst.groupId, "R")).toMatchObject({ width: 200, backgroundColor: "#b2f2bb" });
    click("Undo"); // first dematerialize
    clock.frame();
    expect(masterIds(api, cid).sort()).toEqual([...created.ids].sort());
  });

  it("materialize from a scaled instance rebuilds the master's own geometry", async () => {
    const { api, clock, created, text } = await setup();
    const cid = created.componentId;
    const big = run(api, (d) => insertInstance(d, cid, { x: 0, y: 600, scale: 2 }));
    clock.frame();
    const fontSize = (get(api, text) as ExcalidrawTextElement).fontSize;
    call(() => dematerializeMaster(api, created.masterGroupId));
    clock.frame();
    call(() => materializeMaster(api, big.groupId));
    clock.frame();
    const ids = masterIds(api, cid);
    const rect = all(api).find((e) => ids.includes(e.id) && e.type === "rectangle")!;
    const ell = all(api).find((e) => ids.includes(e.id) && e.type === "ellipse")!;
    expect(rect).toMatchObject({ width: 200, height: 80 });
    expect(ell).toMatchObject({ width: 40, height: 40, x: rect.x + 220, y: rect.y + 20 });
    expect(labelOf(api, rect.id).fontSize).toBe(fontSize);
    // Instances keep their transforms.
    expect(child(api, big.groupId, "R")).toMatchObject({ x: 0, y: 600, width: 400 });
  });

  it("refuses while a master is on the canvas, and in view mode", async () => {
    const { api, created, inst } = await setup();
    expect(call(() => materializeMaster(api, inst.groupId))).toBeNull();
    expect(call(() => adoptInstanceAsMaster(api, inst.groupId))).toBeNull();
    act(() => api.updateScene({ appState: { viewModeEnabled: true } as never }));
    expect(call(() => dematerializeMaster(api, created.masterGroupId))).toBeNull();
    expect(masterIds(api, created.componentId)).toHaveLength(3);
  });

  it("adoptInstanceAsMaster turns an instance into the master with the master's values", async () => {
    const { api, clock, created, inst } = await setup();
    const cid = created.componentId;
    const other = run(api, (d) => insertInstance(d, cid, { x: 0, y: 600 }));
    const r = child(api, inst.groupId, "R");
    userEdit(api, { [r.id]: { backgroundColor: "#b2f2bb" } });
    clock.frame();
    const masterBg = get(api, "R").backgroundColor;
    call(() => dematerializeMaster(api, created.masterGroupId));
    clock.frame();
    expect(call(() => adoptInstanceAsMaster(api, inst.groupId))).toBe(inst.groupId);
    clock.frame();
    expect(tagOf(get(api, r.id))).toMatchObject({ role: "master", source: "library" });
    expect(tagOf(get(api, r.id))!.overrides).toBeUndefined();
    expect(get(api, r.id).backgroundColor).toBe(masterBg);
    userEdit(api, { [r.id]: { width: 300 } });
    clock.frame();
    expect(child(api, other.groupId, "R").width).toBe(300);
    click("Undo");
    click("Undo");
    clock.frame();
    expect(tagOf(get(api, r.id))).toMatchObject({ role: "instance" });
    expect(get(api, r.id).backgroundColor).toBe("#b2f2bb");
  });
});

/** Live child of instance `group` of component `cid` for slot `slot` (nesting-aware). */
const childOf = (api: Api, cid: string, group: string, slot: string) =>
  all(api).find((e) => {
    const t = tagFor(e, cid);
    return !e.isDeleted && t?.role === "instance" && groupOf(e, t) === group && t.slot === slot;
  });
const slotChild = (api: Api, cid: string, group: string, slot: string) =>
  all(api).find((e) => {
    const t = tagFor(e, cid);
    return t?.role === "instance" && groupOf(e, t) === group && t.slot === slot;
  })!;

describe("component properties", () => {
  async function withProps() {
    const s = await setup();
    const cid = s.created.componentId;
    run(s.api, (d) => {
      defineProperty(d, cid, {
        id: "label",
        name: "Label",
        type: "text",
        bindings: [{ elementId: "R" }],
      });
      defineProperty(d, cid, {
        id: "fill",
        name: "Fill",
        type: "color",
        bindings: [{ elementId: "R" }],
      });
      defineProperty(d, cid, {
        id: "badge",
        name: "Badge",
        type: "boolean",
        bindings: [{ elementId: "E" }],
      });
      defineProperty(d, cid, {
        id: "tone",
        name: "Tone",
        type: "choice",
        options: ["info", "warn"],
        bindings: [{ elementId: "E", key: "strokeColor", map: { warn: "#e03131" } }],
      });
    });
    s.clock.frame();
    return { ...s, cid };
  }

  it("instance values drive the bound slots; one undo step; master values are defaults", async () => {
    const { api, clock, cid, inst, text } = await withProps();
    const r = () => childOf(api, cid, inst.groupId, "R")!;
    const label = () => childOf(api, cid, inst.groupId, text) as ExcalidrawTextElement;
    expect(tagOf(r())).toMatchObject({ v: 2 });
    expect(tagOf(r())!.props!.map((p) => p.name)).toEqual(["Label", "Fill", "Badge", "Tone"]);
    run(api, (d) => setProperties(d, inst.groupId, { Label: "Hi", fill: "#a5d8ff", Tone: "warn" }));
    clock.frame();
    expect(label().originalText).toBe("Hi");
    expect(r().backgroundColor).toBe("#a5d8ff");
    expect(childOf(api, cid, inst.groupId, "E")!.strokeColor).toBe("#e03131");
    expect(tagOf(r())!.pv).toEqual({ label: "Hi", fill: "#a5d8ff", tone: "warn" });
    // Badge off: the slot is soft-deleted, and comes back with its id.
    const eId = childOf(api, cid, inst.groupId, "E")!.id;
    run(api, (d) => setProperties(d, inst.groupId, { Badge: false }));
    clock.frame();
    expect(get(api, eId).isDeleted).toBe(true);
    // Master edits still flow to unbound keys, but not over set values.
    userEdit(api, { R: { strokeColor: "#1971c2", backgroundColor: "#ffec99" } });
    userEdit(api, { [text]: { text: "Master", originalText: "Master" } });
    clock.frame();
    expect(r()).toMatchObject({ strokeColor: "#1971c2", backgroundColor: "#a5d8ff" });
    expect(label().originalText).toBe("Hi");
    click("Undo");
    click("Undo");
    click("Undo"); // Badge
    clock.frame();
    expect(get(api, eId).isDeleted).toBe(false);
    // null clears a value back to the master's.
    run(api, (d) => setProperties(d, inst.groupId, { Label: null }));
    clock.frame();
    expect(label().originalText).toBe("Hello");
    click("Undo");
    clock.frame();
    expect(label().originalText).toBe("Hi");
  });

  it("a direct edit to a bound key updates the property value, and setting a value clears overrides", async () => {
    const { api, clock, cid, inst, text } = await withProps();
    const label = childOf(api, cid, inst.groupId, text)!;
    userEdit(api, { [label.id]: { text: "Typed", originalText: "Typed" } });
    clock.frame();
    expect(tagOf(get(api, label.id))!.pv).toEqual({ label: "Typed" });
    expect(tagOf(get(api, label.id))!.overrides).toBeUndefined();
    const r = childOf(api, cid, inst.groupId, "R")!;
    run(api, (d) =>
      setOverrides(d, inst.groupId, [
        { elementId: r.id, values: { backgroundColor: "#ffc9c9", opacity: 50 } },
      ]),
    );
    clock.frame();
    run(api, (d) => setProperties(d, inst.groupId, { Fill: "#b2f2bb" }));
    clock.frame();
    expect(get(api, r.id)).toMatchObject({ backgroundColor: "#b2f2bb", opacity: 50 });
    // A full reset clears property values too.
    run(api, (d) => resetOverrides(d, inst.groupId));
    clock.frame();
    expect(get(api, r.id).backgroundColor).toBe(get(api, "R").backgroundColor);
    expect((get(api, label.id) as ExcalidrawTextElement).originalText).toBe("Hello");
  });

  it("defaults apply to new instances; removing a property restores the master look", async () => {
    const { api, clock, created } = await setup();
    const cid = created.componentId;
    run(api, (d) =>
      defineProperty(d, cid, {
        name: "Badge",
        type: "boolean",
        default: false,
        bindings: [{ elementId: "E" }],
      }),
    );
    const other = run(api, (d) => insertInstance(d, cid, { x: 0, y: 600 }));
    clock.frame();
    expect(childOf(api, cid, other.groupId, "E")).toBeUndefined();
    expect(get(api, "E").isDeleted).toBe(false); // the master itself is untouched
    let dup: unknown = "unset";
    act(() => {
      dup = runComponentCommand(api, (d) =>
        defineProperty(d, cid, { name: "badge", type: "text", bindings: [{ elementId: "R" }] }),
      );
    });
    expect(dup).toBeNull(); // names are unique, case-insensitively
    run(api, (d) => removeProperty(d, cid, "Badge"));
    clock.frame();
    expect(childOf(api, cid, other.groupId, "E")).toBeDefined();
    expect(created.ids).toContain("E");
  });

  it("rejects invalid declarations and values", async () => {
    const { api, cid, inst } = await withProps();
    const bad: Array<() => unknown> = [
      () =>
        runComponentCommand(api, (d) =>
          defineProperty(d, cid, { name: "X", type: "number", bindings: [{ elementId: "R" }] }),
        ),
      () =>
        runComponentCommand(api, (d) =>
          defineProperty(d, cid, { name: "Fill", type: "color", bindings: [{ elementId: "R" }] }),
        ),
      () =>
        runComponentCommand(api, (d) =>
          defineProperty(d, cid, {
            name: "Y",
            type: "choice",
            options: ["a"],
            bindings: [{ elementId: "R", key: "opacity" }],
          }),
        ),
      () =>
        runComponentCommand(api, (d) =>
          defineProperty(d, cid, { name: "Z", type: "text", bindings: [{ elementId: "E" }] }),
        ),
      () => runComponentCommand(api, (d) => setProperties(d, inst.groupId, { Tone: "nope" })),
      () => runComponentCommand(api, (d) => setProperties(d, inst.groupId, { Badge: "yes" })),
      () => runComponentCommand(api, (d) => setProperties(d, "R", { Label: "x" })),
    ];
    for (const fn of bad) {
      let out: unknown = "unset";
      act(() => {
        out = fn();
      });
      expect(out).toBeNull();
    }
  });
});

describe("nested components", () => {
  /** Card (A) as before; Panel (B) = an instance of Card + a frame rect "F". */
  async function nested() {
    const els = [
      ...base(),
      ...convertToExcalidrawElements(
        [
          { type: "rectangle", id: "F", x: -20, y: 280, width: 320, height: 140 },
        ] as ExcalidrawElementSkeleton[],
        { regenerateIds: false },
      ),
    ];
    const s = await setup(els);
    const a = s.created.componentId;
    const b = run(s.api, (d) => createComponent(d, [s.inst.ids[0], "F"], "Panel"));
    s.clock.frame();
    const bInst = run(s.api, (d) => insertInstance(d, b.componentId, { x: 600, y: 280 }));
    s.clock.frame();
    // The Card copy inside the Panel instance.
    const nestedGroup = groupOf(
      childOf(s.api, b.componentId, bInst.groupId, s.inst.ids[0])!,
      tagFor(childOf(s.api, b.componentId, bInst.groupId, s.inst.ids[0])!, a),
    )!;
    return { ...s, a, b, bInst, nestedGroup };
  }

  it("instances of B contain A copies that still follow A, in one cascade", async () => {
    const { api, clock, a, b, bInst, inst, nestedGroup } = await nested();
    expect(
      listComponents(all(api))
        .map((c) => c.name)
        .sort(),
    ).toEqual(["Card", "Panel"]);
    const copy = () => slotChild(api, a, nestedGroup, "R");
    expect(tagsOfIds(api, copy().id)).toEqual([`${a}:instance`, `${b.componentId}:instance`]);
    expect(copy()).toMatchObject({ width: 200, height: 80, x: 620, y: 300 });
    userEdit(api, { R: { backgroundColor: "#ffc9c9", width: 240 } });
    clock.frame();
    expect(slotChild(api, a, inst.groupId, "R")).toMatchObject({
      backgroundColor: "#ffc9c9",
      width: 240,
    });
    expect(copy()).toMatchObject({ backgroundColor: "#ffc9c9", width: 240, x: 620 });
    click("Undo");
    clock.frame();
    expect(copy()).toMatchObject({ width: 200 });
    // Owned nested copies can't be addressed on their own.
    expect(runComponentCommand(api, (d) => resolveFor(d, copy().id))).toBe(bInst.groupId);
  });

  it("overrides at both levels: on the nested master copy, and on the outer instance", async () => {
    const { api, clock, a, b, bInst, inst, nestedGroup } = await nested();
    // A-level override on the Card instance inside B's master flows to every Panel instance.
    const innerR = slotChild(api, a, inst.groupId, "R");
    run(api, (d) =>
      setOverrides(d, inst.groupId, [
        { elementId: innerR.id, values: { backgroundColor: "#d0bfff" } },
      ]),
    );
    clock.frame();
    expect(slotChild(api, a, nestedGroup, "R").backgroundColor).toBe("#d0bfff");
    // B-level override on the copy inside the Panel instance survives A and B master edits.
    const copy = slotChild(api, a, nestedGroup, "R");
    run(api, (d) =>
      setOverrides(d, bInst.groupId, [{ elementId: copy.id, values: { strokeColor: "#2f9e44" } }]),
    );
    clock.frame();
    userEdit(api, { R: { strokeColor: "#1971c2", height: 100 } });
    clock.frame();
    expect(get(api, copy.id)).toMatchObject({
      strokeColor: "#2f9e44",
      backgroundColor: "#d0bfff",
      height: 100,
    });
    expect(tagFor(get(api, copy.id), b.componentId)!.overrides).toEqual({ strokeColor: "#2f9e44" });
  });

  it("nested property values set from the outer instance", async () => {
    const { api, clock, a, bInst, nestedGroup, text } = await nested();
    run(api, (d) =>
      defineProperty(d, a, {
        id: "label",
        name: "Label",
        type: "text",
        bindings: [{ elementId: "R" }],
      }),
    );
    clock.frame();
    const targets = run(api, (d) => instanceProperties(d, bInst.groupId));
    expect(targets).toHaveLength(2);
    const key = targets[1].nestedKey!;
    expect(targets[1].props.map((p) => p.name)).toEqual(["Label"]);
    run(api, (d) => setProperties(d, bInst.groupId, { Label: "Inner" }, { nested: key }));
    clock.frame();
    const label = () => slotChild(api, a, nestedGroup, text) as ExcalidrawTextElement;
    expect(label().originalText).toBe("Inner");
    userEdit(api, { [text]: { text: "Master", originalText: "Master" } });
    clock.frame();
    expect(label().originalText).toBe("Inner");
    click("Undo");
    click("Undo");
    clock.frame();
    expect(label().originalText).toBe("Hello");
  });

  it("rejects cycles and masters; detach and orphan promotion free the nested copies", async () => {
    const { api, clock, a, b, bInst, created, nestedGroup } = await nested();
    const fails = (fn: Parameters<typeof runComponentCommand>[1]) => {
      let out: unknown = "unset";
      act(() => {
        out = runComponentCommand(api, fn);
      });
      expect(out).toBeNull();
    };
    fails((d) => insertInstance(d, b.componentId, { into: created.masterGroupId }));
    fails((d) => insertInstance(d, a, { into: created.masterGroupId }));
    fails((d) => createComponent(d, ["R"]));
    // Insert a Card into the Panel master: Panel instances gain a copy.
    run(api, (d) => insertInstance(d, a, { x: 0, y: 450, into: b.masterGroupId }));
    clock.frame();
    const cards = listComponents(all(api)).find((c) => c.componentId === a)!;
    // Two free Card instances (in the Panel master) plus their owned copies in the Panel instance.
    expect(cards.instances.filter((i) => i.parent?.role !== "instance")).toHaveLength(2);
    expect(cards.instances.filter((i) => i.parent?.role === "instance")).toHaveLength(2);
    // Detaching the Panel instance leaves free Card instances that follow Card.
    run(api, (d) => detachInstance(d, bInst.groupId));
    clock.frame();
    expect(tagFor(slotChild(api, a, nestedGroup, "R"), b.componentId)).toBeNull();
    userEdit(api, { R: { backgroundColor: "#ffd8a8" } });
    clock.frame();
    expect(slotChild(api, a, nestedGroup, "R").backgroundColor).toBe("#ffd8a8");
    click("Undo");
    click("Undo");
    clock.frame();
    // Deleting the Panel master promotes the Panel instance; its Card copies follow Card freely.
    const bMaster = listComponents(all(api)).find((c) => c.componentId === b.componentId)!;
    userEdit(api, Object.fromEntries(bMaster.masterIds.map((id) => [id, { isDeleted: true }])));
    clock.frame();
    expect(tagFor(slotChild(api, a, nestedGroup, "R"), b.componentId)!.role).toBe("master");
    userEdit(api, { R: { backgroundColor: "#c3fae8" } });
    clock.frame();
    expect(slotChild(api, a, nestedGroup, "R").backgroundColor).toBe("#c3fae8");
  });

  it("wrapping exactly one instance nests it in a fresh group", async () => {
    const { api, clock, created, inst } = await setup(base());
    const b = run(api, (d) => createComponent(d, inst.ids, "Wrapper"));
    expect(b.masterGroupId).not.toBe(inst.groupId);
    const el = get(api, inst.ids[0]);
    expect(tagFor(el, created.componentId)!.role).toBe("instance");
    expect(tagFor(el, b.componentId)!.role).toBe("master");
    clock.frame();
    const bInst = run(api, (d) => insertInstance(d, b.componentId, { x: 600, y: 280 }));
    clock.frame();
    userEdit(api, { R: { backgroundColor: "#ffc9c9" } });
    clock.frame();
    const copy = all(api).find(
      (e) => bInst.ids.includes(e.id) && tagFor(e, created.componentId)?.slot === "R",
    )!;
    expect(copy.backgroundColor).toBe("#ffc9c9");
  });

  it("Ctrl/Cmd+D on a Panel instance duplicates the nested copies too", async () => {
    const { api, clock, a, b, bInst } = await nested();
    const ids = listComponents(all(api)).find((c) => c.componentId === b.componentId)!.instances[0]
      .ids;
    act(() =>
      api.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
          selectedGroupIds: { [bInst.groupId]: true },
        } as never,
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    key("d", { ctrlKey: true });
    clock.frame();
    const panel = listComponents(all(api)).find((c) => c.componentId === b.componentId)!;
    expect(panel.instances).toHaveLength(2);
    const dup = panel.instances.find((i) => i.groupId !== bInst.groupId)!;
    const copyR = all(api).find(
      (e) => dup.ids.includes(e.id) && tagFor(e, a)?.slot === "R" && !e.isDeleted,
    )!;
    expect(copyR).toBeDefined();
    userEdit(api, { R: { backgroundColor: "#eebefa" } });
    clock.frame();
    expect(get(api, copyR.id).backgroundColor).toBe("#eebefa");
  });
});

describe("rotated instances", () => {
  it("bound text stays centred and rotated with its container", async () => {
    const { api, clock, created, text } = await setup();
    const rot = run(api, (d) =>
      insertInstance(d, created.componentId, { x: 0, y: 600, angle: Math.PI / 6 }),
    );
    clock.frame();
    userEdit(api, { [text]: { text: "A longer label", originalText: "A longer label" } });
    clock.frame();
    const r = child(api, rot.groupId, "R");
    const label = child(api, rot.groupId, text) as ExcalidrawTextElement;
    expect(label.containerId).toBe(r.id);
    expect(near(label.angle, r.angle)).toBe(true);
    expect(near(r.angle, Math.PI / 6)).toBe(true);
    expect(Math.abs(label.x + label.width / 2 - (r.x + r.width / 2))).toBeLessThan(0.5);
    expect(Math.abs(label.y + label.height / 2 - (r.y + r.height / 2))).toBeLessThan(0.5);
  });
});

describe("masterless components (FR-64)", () => {
  const masters = (api: Api) =>
    all(api).filter((e) => !e.isDeleted && tagsOf(e).some((t) => t.role === "master"));
  const call = <T,>(fn: () => T): T => {
    let out: T | undefined;
    act(() => {
      out = fn();
    });
    return out as T;
  };
  async function masterless(elements: El[] = base()) {
    const api = await mount(elements);
    const clock = manualSchedule();
    const reactor = installComponents(api, { schedule: clock.schedule });
    act(() => api.updateScene({ appState: { selectedElementIds: { R: true, E: true } } as never }));
    const created = call(() => createComponentFromSelection(api, "Card"))!;
    clock.frame();
    const cid = created.componentId;
    const text = labelOf(api, "R").id;
    const inst = call(() => insertComponentInstance(api, cid, { x: 0, y: 300 }))!;
    clock.frame();
    return { api, clock, reactor, created, cid, text, inst };
  }
  /** The master snapshot with `patch(el)` applied to each element. */
  const editedMaster = (api: Api, cid: string, patch: (e: El) => Partial<El> | null) =>
    masterSnapshot(all(api), cid).elements.map((e) => ({ ...e, ...(patch(e) ?? {}) }) as El);

  it("create makes the selection the first instance, with no master; one undo step", async () => {
    const { api, clock, created, cid, inst, text } = await masterless();
    expect(masters(api)).toEqual([]);
    expect(created.groupId).toBe(created.masterGroupId);
    for (const id of ["R", "E", text])
      expect(tagFor(get(api, id), cid)).toMatchObject({ role: "instance", source: "library" });
    expect(get(api, "R")).toMatchObject({ x: 0, y: 0, width: 200 });
    expect(api.getAppState().selectedGroupIds).toEqual({ [created.groupId]: true });
    expect(listComponents(all(api))[0]).toMatchObject({ name: "Card", masterGroupId: null });
    // Instances placed from it follow the same (off-canvas) master.
    expect(child(api, inst.groupId, "R")).toMatchObject({ x: 0, y: 300, width: 200 });
    // Editing the first instance makes overrides, like any instance.
    userEdit(api, { R: { backgroundColor: "#ffc9c9" } });
    clock.frame();
    expect(tagFor(get(api, "R"), cid)!.overrides).toEqual({ backgroundColor: "#ffc9c9" });
    expect(child(api, inst.groupId, "R").backgroundColor).not.toBe("#ffc9c9");
    click("Undo");
    click("Undo");
    clock.frame();
    click("Undo");
    clock.frame();
    expect(tagsOf(get(api, "R"))).toEqual([]);
  });

  it("applyMasterEdit updates every instance in one undo step and leaves no master", async () => {
    const { api, clock, cid, created, inst, text } = await masterless();
    userEdit(api, { R: { backgroundColor: "#ffc9c9" } });
    clock.frame();
    const before = all(api).length;
    const edited = editedMaster(api, cid, (e) =>
      e.type === "rectangle"
        ? { width: 260 }
        : e.type === "text"
          ? ({ text: "Hi", originalText: "Hi" } as Partial<El>)
          : null,
    );
    expect(call(() => applyComponentMasterEdit(api, cid, edited))).toBe(true);
    clock.frame();
    expect(masters(api)).toEqual([]);
    // The temporary master never reaches the scene, not even as deleted elements.
    expect(all(api)).toHaveLength(before);
    for (const g of [created.groupId, inst.groupId]) {
      expect(child(api, g, "R").width).toBe(260);
      expect((child(api, g, text) as ExcalidrawTextElement).originalText).toBe("Hi");
    }
    // Overrides survive the master edit.
    expect(get(api, "R").backgroundColor).toBe("#ffc9c9");
    click("Undo");
    clock.frame();
    for (const g of [created.groupId, inst.groupId]) {
      expect(child(api, g, "R").width).toBe(200);
      expect((child(api, g, text) as ExcalidrawTextElement).originalText).toBe("Hello");
    }
    expect(get(api, "R").backgroundColor).toBe("#ffc9c9");
    click("Redo");
    clock.frame();
    expect(child(api, inst.groupId, "R").width).toBe(260);
  });

  it("an unchanged master edit is not an undo step; added and removed slots apply", async () => {
    const { api, clock, cid, inst } = await masterless();
    const versions = all(api).map((e) => e.version);
    call(() => applyComponentMasterEdit(api, cid, masterSnapshot(all(api), cid).elements));
    clock.frame();
    expect(all(api).map((e) => e.version)).toEqual(versions);
    const snap = masterSnapshot(all(api), cid);
    const ell = snap.elements.find((e) => e.type === "ellipse")!;
    const extra = convertToExcalidrawElements(
      [{ type: "diamond", id: "D", x: ell.x, y: ell.y + 100, width: 30, height: 30 }] as never,
      { regenerateIds: false },
    ).map((e) => ({ ...e, groupIds: [snap.masterGroupId] }) as El);
    call(() =>
      applyComponentMasterEdit(api, cid, [...snap.elements.filter((e) => e !== ell), ...extra]),
    );
    clock.frame();
    expect(masters(api)).toEqual([]);
    expect(child(api, inst.groupId, "E")).toBeUndefined();
    expect(child(api, inst.groupId, "D")).toMatchObject({ type: "diamond", width: 30 });
    expect(get(api, "E").isDeleted).toBe(true);
  });

  it("properties: define on a masterless component, set values, keep them through an edit", async () => {
    const { api, clock, cid, inst, text } = await masterless();
    call(() =>
      defineComponentProperty(api, cid, {
        id: "label",
        name: "Label",
        type: "text",
        bindings: [{ elementId: child(api, inst.groupId, "R").id }],
      }),
    );
    clock.frame();
    expect(masters(api)).toEqual([]);
    call(() => setInstanceProperties(api, inst.groupId, { Label: "Yo" }));
    clock.frame();
    expect((child(api, inst.groupId, text) as ExcalidrawTextElement).originalText).toBe("Yo");
    expect((labelOf(api, "R") as ExcalidrawTextElement).originalText).toBe("Hello");
    expect(runComponentCommand(api, (d) => instanceProperties(d, inst.groupId))![0]).toMatchObject({
      values: { label: "Yo" },
    });
    const edited = editedMaster(api, cid, (e) => (e.type === "rectangle" ? { width: 300 } : null));
    call(() => applyComponentMasterEdit(api, cid, edited));
    clock.frame();
    expect(child(api, inst.groupId, "R").width).toBe(300);
    expect((child(api, inst.groupId, text) as ExcalidrawTextElement).originalText).toBe("Yo");
    expect((labelOf(api, "R") as ExcalidrawTextElement).originalText).toBe("Hello");
  });

  it("nested: a Card edit reaches the Card copies inside masterless Panel instances", async () => {
    const els = [
      ...base(),
      ...convertToExcalidrawElements(
        [
          { type: "rectangle", id: "F", x: -20, y: 280, width: 320, height: 140 },
        ] as ExcalidrawElementSkeleton[],
        { regenerateIds: false },
      ),
    ];
    const { api, clock, cid, inst } = await masterless(els);
    act(() =>
      api.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries([...inst.ids, "F"].map((id) => [id, true])),
        } as never,
      }),
    );
    const panel = call(() => createComponentFromSelection(api, "Panel"))!;
    clock.frame();
    const b = panel.componentId;
    // A nested property value on the first Panel survives the edit (keyed by its Card copy).
    const bInst = call(() => insertComponentInstance(api, b, { x: 600, y: 280 }))!;
    clock.frame();
    expect(masters(api)).toEqual([]);
    const copyOf = (group: string) => {
      const c = all(api).find(
        (e) =>
          !e.isDeleted &&
          tagFor(e, b)?.role === "instance" &&
          groupOf(e, tagFor(e, b)) === group &&
          tagFor(e, cid)?.slot === "R",
      )!;
      return c;
    };
    expect(copyOf(bInst.groupId)).toMatchObject({ width: 200, x: 620 });
    const edited = editedMaster(api, cid, (e) =>
      e.type === "rectangle" ? { width: 240, backgroundColor: "#a5d8ff" } : null,
    );
    call(() => applyComponentMasterEdit(api, cid, edited));
    clock.frame();
    expect(masters(api)).toEqual([]);
    for (const g of [panel.groupId, bInst.groupId])
      expect(copyOf(g)).toMatchObject({ width: 240, backgroundColor: "#a5d8ff" });
    expect(get(api, "R")).toMatchObject({ width: 240 });
    click("Undo");
    clock.frame();
    for (const g of [panel.groupId, bInst.groupId]) expect(copyOf(g)).toMatchObject({ width: 200 });
    // Editing the Panel keeps its Card copies following Card.
    const snap = editedMaster(api, b, (e) =>
      e.id === "F" || (e.type === "rectangle" && !tagFor(e, cid)) ? { height: 200 } : null,
    );
    call(() => applyComponentMasterEdit(api, b, snap));
    clock.frame();
    expect(masters(api)).toEqual([]);
    expect(copyOf(bInst.groupId)).toMatchObject({ width: 200, x: 620 });
  });

  it("nested property values survive master edits of the outer component", async () => {
    const els = [
      ...base(),
      ...convertToExcalidrawElements(
        [
          { type: "rectangle", id: "F", x: -20, y: 280, width: 320, height: 140 },
        ] as ExcalidrawElementSkeleton[],
        { regenerateIds: false },
      ),
    ];
    const { api, clock, cid, inst, text } = await masterless(els);
    call(() =>
      defineComponentProperty(api, cid, {
        id: "label",
        name: "Label",
        type: "text",
        bindings: [{ elementId: "R" }],
      }),
    );
    clock.frame();
    act(() =>
      api.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries([...inst.ids, "F"].map((id) => [id, true])),
        } as never,
      }),
    );
    const panel = call(() => createComponentFromSelection(api, "Panel"))!;
    clock.frame();
    const b = panel.componentId;
    const bInst = call(() => insertComponentInstance(api, b, { x: 600, y: 280 }))!;
    clock.frame();
    const props = runComponentCommand(api, (d) => instanceProperties(d, bInst.groupId))!;
    const nestedKey = props[1]!.nestedKey!;
    call(() =>
      setInstanceProperties(api, bInst.groupId, { Label: "Nested" }, { nested: nestedKey }),
    );
    clock.frame();
    const labelIn = (group: string) =>
      all(api).find(
        (e) => !e.isDeleted && groupOf(e, tagFor(e, b)) === group && tagFor(e, cid)?.slot === text,
      ) as ExcalidrawTextElement;
    expect(labelIn(bInst.groupId).originalText).toBe("Nested");
    expect(labelIn(panel.groupId).originalText).toBe("Hello");
    call(() =>
      applyComponentMasterEdit(
        api,
        b,
        editedMaster(api, b, (e) => (e.id === "F" || !tagFor(e, cid) ? { height: 220 } : null)),
      ),
    );
    clock.frame();
    expect(labelIn(bInst.groupId).originalText).toBe("Nested");
    call(() =>
      applyComponentMasterEdit(
        api,
        cid,
        editedMaster(api, cid, (e) => (e.type === "rectangle" ? { width: 230 } : null)),
      ),
    );
    clock.frame();
    expect(labelIn(bInst.groupId).originalText).toBe("Nested");
    expect(masters(api)).toEqual([]);
  });

  it("images: the edit's files are added and instances show the new image", async () => {
    const { api, clock, cid, inst } = await masterless();
    const snap = masterSnapshot(all(api), cid);
    const img = {
      ...convertToExcalidrawElements(
        [{ type: "rectangle", id: "I", x: 0, y: 100, width: 20, height: 20 }] as never,
        { regenerateIds: false },
      )[0],
      type: "image",
      fileId: "file-1",
      status: "saved",
      scale: [1, 1],
      crop: null,
      groupIds: [snap.masterGroupId],
    } as unknown as El;
    const file = {
      id: "file-1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,iVBORw0KGgo=",
      created: 1,
    } as never;
    call(() => applyComponentMasterEdit(api, cid, [...snap.elements, img], [file]));
    clock.frame();
    expect(api.getFiles()["file-1"]).toBeDefined();
    expect(child(api, inst.groupId, "I")).toMatchObject({ type: "image", fileId: "file-1" });
    expect(masterSnapshot(all(api), cid).files).toEqual(["file-1"]);
  });

  it("migration: legacy on-canvas masters become instances without moving", async () => {
    const { api, clock, created, inst } = await setup();
    const cid = created.componentId;
    run(api, (d) =>
      defineProperty(d, cid, {
        id: "fill",
        name: "Fill",
        type: "color",
        bindings: [{ elementId: "R" }],
      }),
    );
    run(api, (d) => setProperties(d, inst.groupId, { fill: "#a5d8ff" }));
    clock.frame();
    const look = all(api).map((e) => [e.id, e.x, e.y, e.width, e.backgroundColor]);
    // On load: the file's elements are migrated before the editor sees them.
    const saved = all(api);
    const loaded = demoteMastersIn(saved);
    expect(loaded.filter((e) => tagsOf(e).some((t) => t.role === "master"))).toEqual([]);
    expect(loaded.map((e) => [e.id, e.x, e.y, e.width, e.backgroundColor])).toEqual(look);
    expect(demoteMastersIn(loaded)).toBe(loaded);
    expect(call(() => demoteLegacyMasters(api))).toBe(1);
    clock.frame();
    expect(masters(api)).toEqual([]);
    expect(all(api).map((e) => [e.id, e.x, e.y, e.width, e.backgroundColor])).toEqual(look);
    expect(tagFor(get(api, "R"), cid)).toMatchObject({ role: "instance", source: "library" });
    // Not an undo step: undo reverts the property value, not the migration.
    click("Undo");
    clock.frame();
    expect(masters(api)).toEqual([]);
    // And the component still edits as a whole.
    call(() =>
      applyComponentMasterEdit(
        api,
        cid,
        editedMaster(api, cid, (e) => (e.type === "ellipse" ? { width: 60 } : null)),
      ),
    );
    clock.frame();
    expect(child(api, inst.groupId, "E").width).toBe(60);
    expect(get(api, "E").width).toBe(60);
    expect(call(() => demoteLegacyMasters(api))).toBe(0);
  });

  it("migration: the demoted master shows the property defaults, like a new instance", async () => {
    const { api, clock, created, inst, text } = await setup();
    const cid = created.componentId;
    // Avatar: "photo" shows R (with its label), "initials" shows E; the master shows both.
    run(api, (d) =>
      defineProperty(d, cid, {
        id: "avatar",
        name: "Avatar",
        type: "choice",
        options: ["photo", "initials"],
        default: "photo",
        bindings: [
          { elementId: "R", key: "visible", map: { photo: true, initials: false } },
          { elementId: "E", key: "visible", map: { photo: false, initials: true } },
        ],
      }),
    );
    run(api, (d) => setProperties(d, inst.groupId, { avatar: "initials" }));
    clock.frame();
    const loaded = demoteMastersIn(all(api));
    const at = (id: string) => loaded.find((e) => e.id === id)!;
    expect(at("R").isDeleted).toBe(false);
    expect(at(text).isDeleted).toBe(false);
    expect(at("E").isDeleted).toBe(true);
    expect(tagFor(at("E"), cid)).toMatchObject({ role: "instance" });
    // The other instance keeps its own choice.
    const other = (slot: string) =>
      loaded.find((e) => {
        const t = tagFor(e, cid);
        return t?.role === "instance" && groupOf(e, t) === inst.groupId && t.slot === slot;
      })!;
    expect(other("R").isDeleted).toBe(true);
    expect(other("E").isDeleted).toBe(false);
    // Choosing the other branch on the demoted card reveals it.
    const { api: api2, clock: clock2 } = await (async () => {
      cleanup();
      const a = await mount(loaded as El[]);
      const c = manualSchedule();
      installComponents(a, { schedule: c.schedule });
      return { api: a, clock: c };
    })();
    call(() => setInstanceProperties(api2, created.masterGroupId, { avatar: "initials" }));
    clock2.frame();
    expect(get(api2, "E").isDeleted).toBe(false);
    expect(get(api2, "R").isDeleted).toBe(true);
  });

  describe("instance-local edits never reach the master (FR-67)", () => {
    /** Card: rectangle R, free title text T, image I; Title property on T; two more instances. */
    async function card() {
      const els = [
        ...convertToExcalidrawElements(
          [
            { type: "rectangle", id: "R", x: 0, y: 0, width: 200, height: 120 },
            { type: "text", id: "T", x: 10, y: 60, text: "Job title", fontSize: 20 },
          ] as ExcalidrawElementSkeleton[],
          { regenerateIds: false },
        ),
        {
          ...convertToExcalidrawElements(
            [{ type: "rectangle", id: "I", x: 10, y: 10, width: 40, height: 40 }] as never,
            { regenerateIds: false },
          )[0],
          type: "image",
          fileId: "file-1",
          status: "saved",
          scale: [1, 1],
          crop: null,
        } as unknown as El,
      ];
      const api = await mount(els);
      act(() =>
        api.addFiles(
          ["file-1", "file-2"].map((id) => ({
            id,
            mimeType: "image/png",
            dataURL: "data:image/png;base64,iVBORw0KGgo=",
            created: 1,
          })) as never,
        ),
      );
      const clock = manualSchedule();
      installComponents(api, { schedule: clock.schedule });
      act(() =>
        api.updateScene({
          appState: { selectedElementIds: { R: true, T: true, I: true } } as never,
        }),
      );
      const created = call(() => createComponentFromSelection(api, "Person"))!;
      clock.frame();
      const cid = created.componentId;
      call(() =>
        defineComponentProperty(api, cid, {
          id: "title",
          name: "Title",
          type: "text",
          bindings: [{ elementId: "T" }],
        }),
      );
      const a = call(() => insertComponentInstance(api, cid, { x: 0, y: 300 }))!.groupId;
      const b = call(() => insertComponentInstance(api, cid, { x: 300, y: 300 }))!.groupId;
      clock.frame();
      return { api, clock, cid, first: created.groupId, a, b };
    }
    const font = (api: Api, group: string) =>
      (child(api, group, "T") as ExcalidrawTextElement).fontSize;
    const snapFont = (api: Api, cid: string, instance?: string) =>
      (
        masterSnapshot(all(api), cid, instance).elements.find(
          (e) => e.type === "text",
        ) as ExcalidrawTextElement
      ).fontSize;

    it("Reset overrides resets the enlarged font on that instance only and keeps its data", async () => {
      const { api, clock, cid, first, a, b } = await card();
      call(() => setInstanceProperties(api, a, { Title: "Studio Head" }));
      call(() => setInstanceOverrides(api, a, [{ slot: "I", values: { fileId: "file-2" } }]));
      call(() =>
        setInstanceOverrides(api, a, [{ slot: "R", values: { backgroundColor: "#ffc9c9" } }]),
      );
      clock.frame();
      // The user makes A's title (and, separately, B's) larger.
      userEdit(api, { [child(api, a, "T").id]: { fontSize: 40 } });
      userEdit(api, { [child(api, b, "T").id]: { fontSize: 30 } });
      clock.frame();
      expect(font(api, a)).toBe(40);
      // Rebuilding the master from the edited instance (Edit master… / Save) uses the master's size.
      expect(snapFont(api, cid, a)).toBe(20);

      call(() => resetInstanceOverrides(api, a, { content: false }));
      clock.frame();
      expect(font(api, a)).toBe(20);
      // Nothing else changed: not the other instances, not the master.
      expect(font(api, b)).toBe(30);
      expect(font(api, first)).toBe(20);
      expect(snapFont(api, cid)).toBe(20);
      // Property values and the image stay; style overrides go.
      expect((child(api, a, "T") as ExcalidrawTextElement).originalText).toBe("Studio Head");
      expect(child(api, a, "I")).toMatchObject({ fileId: "file-2" });
      expect(child(api, a, "R").backgroundColor).toBe(get(api, "R").backgroundColor);
      expect(tagFor(child(api, a, "T"), cid)!.pv).toEqual({ title: "Studio Head" });
    });

    it("commands on an instance with an enlarged font don't spread it to the others", async () => {
      const { api, clock, cid, first, a, b } = await card();
      userEdit(api, { [child(api, a, "T").id]: { fontSize: 40 } });
      clock.frame();
      call(() => setInstanceProperties(api, a, { Title: "Studio Head" }));
      clock.frame();
      expect(font(api, a)).toBe(40);
      expect(font(api, b)).toBe(20);
      expect(font(api, first)).toBe(20);
      // A master edit keeps the instance's own size and moves the others.
      const edited = masterSnapshot(all(api), cid, a).elements.map((e) =>
        e.type === "text" ? ({ ...e, fontSize: 24 } as El) : e,
      );
      call(() => applyComponentMasterEdit(api, cid, edited));
      clock.frame();
      expect(font(api, a)).toBe(40);
      expect(font(api, b)).toBe(24);
      // Per-slot reset (the override's ×) restores the master's size.
      call(() => resetInstanceOverrides(api, a, { slots: ["T"] }));
      clock.frame();
      expect(font(api, a)).toBe(24);
      expect(snapFont(api, cid)).toBe(24);
    });

    it("legacy drift (no recorded master size) is not copied into the master", async () => {
      const { api, clock, cid, a, b } = await card();
      // A file from an older build: no master font size recorded, A's title already enlarged.
      const t = child(api, a, "T");
      const legacy = (e: El) => {
        const tag = tagFor(e, cid)!;
        const ms = { ...(tag.ms ?? {}) };
        delete ms.fontSize;
        return withTag(e, { ...tag, ms });
      };
      act(() =>
        api.updateScene({
          elements: all(api).map((e) =>
            tagFor(e, cid)
              ? ({ ...e, ...(e.id === t.id ? { fontSize: 40 } : {}), customData: legacy(e) } as El)
              : e,
          ),
          captureUpdate: CaptureUpdateAction.NEVER,
        }),
      );
      clock.frame();
      expect(snapFont(api, cid, a)).toBe(20);
      call(() => resetInstanceOverrides(api, a, { content: false }));
      clock.frame();
      expect(font(api, a)).toBe(20);
      expect(font(api, b)).toBe(20);
    });
  });
});
