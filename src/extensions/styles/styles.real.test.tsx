// Named styles against the REAL Excalidraw 0.18.1 (Store/History) in jsdom, with the components
// rule installed alongside (D-DX12 rule order).
import "../../agent/scene/testHarness";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { Draft } from "../../agent/scene/draft";
import type { El } from "../reactor/reactor";
import { createComponent, insertInstance } from "../components/actions";
import { componentsOnDuplicate } from "../components/duplicate";
import { installComponents, runComponentCommand, uninstallComponents } from "../components/host";
import { groupOf, tagOf } from "../components/model";
import {
  applyStyle,
  createStyle,
  deleteStyle,
  pushOverridesToStyle,
  resetStyleOverrides,
  updateStyle,
} from "./actions";
import { runStyleCommand } from "./host";
import { listStyles, STYLE_NS, styleTagOf, withStyleTag } from "./model";

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

/** Labelled rectangle "R", ellipse "E", free text "T". */
function base(): El[] {
  return convertToExcalidrawElements(
    [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 200, height: 80, label: { text: "Hello" } },
      { type: "ellipse", id: "E", x: 220, y: 20, width: 40, height: 40 },
      { type: "text", id: "T", x: 0, y: 200, text: "Free text" },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
}

async function setup(elements: El[] = base()) {
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
  const clock = manualSchedule();
  installComponents(api!, { schedule: clock.schedule });
  return { api: api as unknown as Api, clock };
}

const all = (api: Api) => api.getSceneElementsIncludingDeleted();
const get = (api: Api, id: string) => all(api).find((e) => e.id === id)!;
const labelOf = (api: Api, containerId: string) =>
  all(api).find(
    (e) => !e.isDeleted && (e as ExcalidrawTextElement).containerId === containerId,
  ) as ExcalidrawTextElement;
const click = (label: "Undo" | "Redo") =>
  act(() => void fireEvent.click(document.querySelector(`[aria-label="${label}"]`)!));

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

function run<T>(api: Api, fn: (d: Draft) => T): T {
  let out: T | null = null;
  act(() => {
    out = runStyleCommand(api, fn);
  });
  expect(out).not.toBeNull();
  return out!;
}

describe("named styles (real Excalidraw)", () => {
  it("editing a style updates every linked element live, as one undo step", async () => {
    const { api, clock } = await setup();
    const { styleId } = run(api, (d) =>
      createStyle(d, ["R", "E"], "Primary", { strokeColor: "#1971c2", backgroundColor: "#a5d8ff" }),
    );
    clock.frame();
    for (const id of ["R", "E"]) {
      expect(get(api, id).strokeColor).toBe("#1971c2");
      expect(styleTagOf(get(api, id))?.id).toBe(styleId);
    }
    // The label of R is linked too (text keys only: none set, so its look is unchanged).
    expect(styleTagOf(labelOf(api, "R"))?.id).toBe(styleId);

    run(api, (d) =>
      updateStyle(d, styleId, { props: { strokeColor: "#e03131", fillStyle: "solid" } }),
    );
    clock.frame();
    for (const id of ["R", "E"]) {
      expect(get(api, id).strokeColor).toBe("#e03131");
      expect(get(api, id).fillStyle).toBe("solid");
    }
    expect(clock.scheduled()).toBe(0);

    click("Undo");
    clock.frame();
    for (const id of ["R", "E"]) expect(get(api, id).strokeColor).toBe("#1971c2");
    expect(listStyles(all(api))[0].rev).toBe(1);
    click("Redo");
    clock.frame();
    for (const id of ["R", "E"]) expect(get(api, id).strokeColor).toBe("#e03131");
  });

  it("a direct edit becomes a local override that survives style edits until reset", async () => {
    const { api, clock } = await setup();
    const { styleId } = run(api, (d) =>
      createStyle(d, ["R", "E"], "S", { strokeColor: "#1971c2" }),
    );
    clock.frame();

    userEdit(api, { E: { strokeColor: "#2f9e44", x: 230 } });
    clock.frame();
    expect(styleTagOf(get(api, "E"))?.overrides).toEqual({ strokeColor: "#2f9e44" });
    // Only the stroke changed: moving isn't an override.
    expect(Object.keys(styleTagOf(get(api, "E"))!.overrides!)).toEqual(["strokeColor"]);

    run(api, (d) => updateStyle(d, styleId, { props: { strokeColor: "#000000", strokeWidth: 4 } }));
    clock.frame();
    expect(get(api, "R").strokeColor).toBe("#000000");
    expect(get(api, "E").strokeColor).toBe("#2f9e44");
    expect(get(api, "E").strokeWidth).toBe(4);

    // Undo of the direct edit's override is part of the user's step.
    run(api, (d) => resetStyleOverrides(d, ["E"]));
    clock.frame();
    expect(get(api, "E").strokeColor).toBe("#000000");
    expect(styleTagOf(get(api, "E"))?.overrides).toBeUndefined();

    // Setting the style's own value again drops an override.
    userEdit(api, { E: { strokeColor: "#2f9e44" } });
    clock.frame();
    userEdit(api, { E: { strokeColor: "#000000" } });
    clock.frame();
    expect(styleTagOf(get(api, "E"))?.overrides).toBeUndefined();

    // Push an override into the style.
    userEdit(api, { E: { strokeColor: "#f08c00" } });
    clock.frame();
    run(api, (d) => pushOverridesToStyle(d, "E"));
    clock.frame();
    expect(get(api, "R").strokeColor).toBe("#f08c00");
    expect(styleTagOf(get(api, "E"))?.overrides).toBeUndefined();
  });

  it("an undone direct edit restores the element's previous override state", async () => {
    const { api, clock } = await setup();
    run(api, (d) => createStyle(d, ["E"], "S", { strokeColor: "#1971c2" }));
    clock.frame();
    userEdit(api, { E: { strokeColor: "#2f9e44" } });
    clock.frame();
    expect(styleTagOf(get(api, "E"))?.overrides).toEqual({ strokeColor: "#2f9e44" });
    click("Undo");
    clock.frame();
    expect(get(api, "E").strokeColor).toBe("#1971c2");
    expect(styleTagOf(get(api, "E"))?.overrides).toBeUndefined();
  });

  it("deleting a style unlinks its elements and keeps their look; undo restores it", async () => {
    const { api, clock } = await setup();
    const { styleId } = run(api, (d) =>
      createStyle(d, ["R", "E"], "S", { strokeColor: "#1971c2" }),
    );
    clock.frame();
    run(api, (d) => deleteStyle(d, styleId));
    clock.frame();
    expect(listStyles(all(api))).toEqual([]);
    expect(get(api, "R").customData?.[STYLE_NS]).toBeUndefined();
    expect(get(api, "R").strokeColor).toBe("#1971c2");
    click("Undo");
    clock.frame();
    expect(listStyles(all(api)).map((s) => s.name)).toEqual(["S"]);

    // Unlinking one element leaves the others linked.
    run(api, (d) => applyStyle(d, ["E"], null));
    clock.frame();
    expect(listStyles(all(api))[0].elementIds.sort()).toEqual(["R", labelOf(api, "R").id].sort());
  });

  it("font changes re-measure free and bound text", async () => {
    const { api, clock } = await setup();
    const { styleId } = run(api, (d) => createStyle(d, ["R", "T"], "Type", { fontSize: 20 }));
    clock.frame();
    const before = { free: get(api, "T").height, label: labelOf(api, "R").height };
    run(api, (d) => updateStyle(d, styleId, { props: { fontSize: 40, fontFamily: "Nunito" } }));
    clock.frame();
    const t = get(api, "T") as ExcalidrawTextElement;
    expect(t.fontSize).toBe(40);
    expect(t.height).toBeGreaterThan(before.free);
    expect(labelOf(api, "R").fontSize).toBe(40);
    expect(labelOf(api, "R").height).toBeGreaterThan(before.label);
    expect(t.lineHeight).toBeGreaterThan(0);
  });

  it("a pasted copy with an older definition adopts the current style", async () => {
    const { api, clock } = await setup();
    const { styleId } = run(api, (d) => createStyle(d, ["R"], "S", { strokeColor: "#1971c2" }));
    clock.frame();
    const stale = styleTagOf(get(api, "R"))!;
    run(api, (d) => updateStyle(d, styleId, { props: { strokeColor: "#e03131" } }));
    clock.frame();
    // Paste: a new element carrying the rev-1 tag and rev-1 look.
    const [copy] = convertToExcalidrawElements(
      [{ type: "ellipse", id: "P", x: 400, y: 0, width: 40, height: 40, strokeColor: "#1971c2" }],
      { regenerateIds: false },
    );
    act(() =>
      api.updateScene({
        elements: [...all(api), newElementWith(copy, { customData: withStyleTag(copy, stale) })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    clock.frame();
    expect(get(api, "P").strokeColor).toBe("#e03131");
    expect(styleTagOf(get(api, "P"))?.rev).toBe(2);
  });

  it("survives save + reload with overrides and keeps syncing", async () => {
    const { api, clock } = await setup();
    const { styleId } = run(api, (d) =>
      createStyle(d, ["R", "E"], "S", { strokeColor: "#1971c2" }),
    );
    clock.frame();
    userEdit(api, { E: { strokeColor: "#2f9e44" } });
    clock.frame();
    const saved = JSON.parse(JSON.stringify(all(api)));
    cleanup();
    const { api: api2, clock: clock2 } = await setup(restoreElements(saved, null) as El[]);
    expect(listStyles(all(api2)).map((s) => s.id)).toEqual([styleId]);
    run(api2, (d) => updateStyle(d, styleId, { props: { strokeColor: "#e03131" } }));
    clock2.frame();
    expect(get(api2, "R").strokeColor).toBe("#e03131");
    expect(get(api2, "E").strokeColor).toBe("#2f9e44");
  });

  describe("with components", () => {
    async function withComponent() {
      const s = await setup();
      let created!: ReturnType<typeof createComponent>;
      act(() => {
        created = runComponentCommand(s.api, (d) => createComponent(d, ["R", "E"], "Card"))!;
      });
      const inst = runComponentCommand(s.api, (d) =>
        insertInstance(d, created.componentId, { x: 0, y: 300 }),
      )!;
      s.clock.frame();
      const instChild = (slot: string) =>
        all(s.api).find((e) => {
          const t = tagOf(e);
          return (
            !e.isDeleted &&
            t?.role === "instance" &&
            groupOf(e, t) === inst.groupId &&
            t.slot === slot
          );
        })!;
      return { ...s, created, instChild };
    }

    it("a styled master child reaches its instances, never as an instance override", async () => {
      const { api, clock, instChild } = await withComponent();
      const slotE = tagOf(get(api, "E"))!.slot;
      const { styleId } = run(api, (d) =>
        createStyle(d, ["E"], "Accent", { strokeColor: "#1971c2" }),
      );
      clock.frame();
      expect(instChild(slotE).strokeColor).toBe("#1971c2");

      run(api, (d) => updateStyle(d, styleId, { props: { strokeColor: "#e03131" } }));
      clock.frame();
      expect(get(api, "E").strokeColor).toBe("#e03131");
      expect(instChild(slotE).strokeColor).toBe("#e03131");
      expect(tagOf(instChild(slotE))?.overrides).toBeUndefined();
      // Instance children are not members of the style (they follow the master).
      expect(listStyles(all(api))[0].elementIds).toEqual(["E"]);
      expect(clock.scheduled()).toBe(0);

      // One undo step reverts the master child and its instances together.
      click("Undo");
      clock.frame();
      expect(get(api, "E").strokeColor).toBe("#1971c2");
      expect(instChild(slotE).strokeColor).toBe("#1971c2");

      // A direct edit of the styled master child: a style override, propagated in one flush.
      userEdit(api, { E: { strokeColor: "#2f9e44" } });
      clock.frame();
      expect(styleTagOf(get(api, "E"))?.overrides).toEqual({ strokeColor: "#2f9e44" });
      expect(instChild(slotE).strokeColor).toBe("#2f9e44");
      expect(clock.scheduled()).toBe(0);
    });

    it("instance children can't be styled directly", async () => {
      const { api, instChild } = await withComponent();
      const slotE = tagOf(get(api, "E"))!.slot;
      let out: unknown = "unset";
      act(() => {
        out = runStyleCommand(api, (d) => createStyle(d, [instChild(slotE).id], "X"));
      });
      expect(out).toBeNull();
      expect(listStyles(all(api))).toEqual([]);
    });
  });
});
