// Smart containers against the REAL Excalidraw 0.18.1 (Store/History) in jsdom: live re-flow
// through the shared reactor, one undo step per user action, gesture holds, components interplay.
import "../../agent/scene/testHarness";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawArrowElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { El } from "../../extensions/reactor/reactor";
import { createComponent, insertInstance } from "../../extensions/components/actions";
import { componentsOnDuplicate } from "../../extensions/components/duplicate";
import { installComponents, uninstallComponents } from "../../extensions/components/host";
import { groupOf, tagOf } from "../../extensions/components/model";
import { addToContainer, makeContainer, updateContainer } from "./actions";
import { runContainerCommand } from "./host";

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

const skeleton = (s: unknown[]) =>
  convertToExcalidrawElements(s as ExcalidrawElementSkeleton[], { regenerateIds: false });

/** A 100×40, B 60×60 (far right), C 80×30; X off to the side; arrow C → X. */
function base(): El[] {
  return skeleton([
    { type: "rectangle", id: "A", x: 0, y: 0, width: 100, height: 40 },
    { type: "rectangle", id: "B", x: 300, y: 200, width: 60, height: 60 },
    { type: "rectangle", id: "C", x: 0, y: 300, width: 80, height: 30 },
    { type: "rectangle", id: "X", x: 600, y: 300, width: 50, height: 50 },
    { type: "arrow", id: "AR", x: 80, y: 315, start: { id: "C" }, end: { id: "X" } },
  ]);
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
const pos = (api: Api, id: string) => {
  const e = get(api, id);
  return { x: e.x, y: e.y, w: e.width, h: e.height };
};
const button = (label: "Undo" | "Redo") =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const click = (label: "Undo" | "Redo") => act(() => void fireEvent.click(button(label)));

function userEdit(api: Api, patches: Record<string, Record<string, unknown>>, extra: El[] = []) {
  act(() =>
    api.updateScene({
      elements: [
        ...all(api).map((e) =>
          patches[e.id]
            ? { ...e, ...patches[e.id], version: e.version + 1, versionNonce: e.versionNonce + 1 }
            : e,
        ),
        ...extra,
      ],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    }),
  );
}

function run<T>(api: Api, fn: Parameters<typeof runContainerCommand<T>>[1]): T {
  let out: T | null = null;
  act(() => {
    out = runContainerCommand(api, fn);
  });
  expect(out).not.toBeNull();
  return out!;
}

async function setup(elements: El[] = base()) {
  const api = await mount(elements);
  const clock = manualSchedule();
  const reactor = installComponents(api, { schedule: clock.schedule });
  return { api, clock, reactor };
}

async function stacked() {
  const s = await setup();
  const made = run(s.api, (d) => makeContainer(d, ["A", "B", "C"], { gap: 10, padding: 8 }));
  s.clock.frame();
  return { ...s, made };
}

describe("make container", () => {
  it("stacks the selection in a hugging box, arrows follow, one undo step", async () => {
    const { api, made, reactor } = await stacked();
    expect(pos(api, "A")).toMatchObject({ x: 0, y: 0 });
    expect(pos(api, "B")).toMatchObject({ x: 0, y: 50 });
    expect(pos(api, "C")).toMatchObject({ x: 0, y: 120 });
    expect(pos(api, made.containerId)).toEqual({ x: -8, y: -8, w: 116, h: 166 });
    // The box paints under the children.
    const order = all(api).map((e) => e.id);
    expect(order.indexOf(made.containerId)).toBeLessThan(order.indexOf("A"));
    // The arrow bound to C moved with it.
    const ar = get(api, "AR") as ExcalidrawArrowElement;
    expect(ar.y).toBeLessThan(200);
    // The command re-flowed in its own draft: nothing left for the live rule.
    expect(reactor.stats.patched).toBe(0);

    click("Undo");
    expect(get(api, made.containerId).isDeleted).toBe(true);
    expect(pos(api, "B")).toMatchObject({ x: 300, y: 200 });
    expect(get(api, "A").groupIds).toEqual([]);
    expect((get(api, "AR") as ExcalidrawArrowElement).y).toBeGreaterThan(250);
  });
});

describe("live re-flow", () => {
  it("child resize re-flows siblings and the box; one undo reverts both", async () => {
    const { api, clock, made } = await stacked();
    userEdit(api, { A: { height: 100 } });
    clock.frame();
    expect(pos(api, "B").y).toBe(110);
    expect(pos(api, "C").y).toBe(180);
    expect(pos(api, made.containerId).h).toBe(226);
    click("Undo");
    clock.frame();
    expect(pos(api, "A").h).toBe(40);
    expect(pos(api, "B").y).toBe(50);
    expect(pos(api, made.containerId).h).toBe(166);
    // Redo stays available: the re-flow never became its own history entry.
    expect(button("Redo").disabled).toBe(false);
  });

  it("adding a member slots it in; deleting one closes the gap", async () => {
    const { api, clock, made } = await stacked();
    const [d] = skeleton([{ type: "ellipse", id: "D", x: 400, y: 60, width: 20, height: 20 }]);
    userEdit(api, {}, [{ ...d, groupIds: [made.groupId] }]);
    clock.frame();
    // Centre y=70 sorts between A (20) and B (80).
    expect(pos(api, "D")).toMatchObject({ x: 0, y: 50 });
    expect(pos(api, "B").y).toBe(80);
    userEdit(api, { A: { isDeleted: true } });
    clock.frame();
    expect(pos(api, "D").y).toBe(0);
    expect(pos(api, made.containerId).h).toBe(8 + 20 + 10 + 60 + 10 + 30 + 8);
  });

  it("a text child that grows re-flows (text edits resize)", async () => {
    const s = await setup(
      skeleton([
        { type: "text", id: "T", x: 0, y: 0, text: "Hi" },
        { type: "rectangle", id: "B", x: 0, y: 100, width: 60, height: 60 },
      ]),
    );
    const made = run(s.api, (d) => makeContainer(d, ["T", "B"], { gap: 10, padding: 0 }));
    const t = pos(s.api, "T");
    userEdit(s.api, {
      T: { text: "Hi\nthere", originalText: "Hi\nthere", height: t.h * 2 },
    });
    s.clock.frame();
    expect(pos(s.api, "B").y).toBe(t.y + t.h * 2 + 10);
    expect(pos(s.api, made.containerId).h).toBe(t.h * 2 + 10 + 60);
  });

  it("holds the dragged child until the gesture ends, then settles it in order", async () => {
    const { api, clock } = await stacked();
    act(() =>
      api.updateScene({
        appState: { selectedElementIds: { C: true }, selectedElementsAreBeingDragged: true },
      } as never),
    );
    userEdit(api, { C: { y: -60, x: 40 } });
    clock.frame();
    // Held: C stays under the pointer; A and B re-flow without it.
    expect(pos(api, "C")).toMatchObject({ x: 40, y: -60 });
    act(() => api.updateScene({ appState: { selectedElementsAreBeingDragged: false } } as never));
    clock.frame();
    // Dropped above A: C is now first.
    expect(pos(api, "C")).toMatchObject({ x: 0, y: 0 });
    expect(pos(api, "A").y).toBe(40);
    expect(pos(api, "B").y).toBe(90);
  });

  it("settings change re-flows as one undo step", async () => {
    const { api, made } = await stacked();
    run(api, (d) =>
      updateContainer(d, made.containerId, { direction: "horizontal", align: "end" }),
    );
    expect(pos(api, "A")).toMatchObject({ x: 0, y: 20 });
    expect(pos(api, "B")).toMatchObject({ x: 110, y: 0 });
    expect(pos(api, "C")).toMatchObject({ x: 180, y: 30 });
    click("Undo");
    expect(pos(api, "B")).toMatchObject({ x: 0, y: 50 });
  });

  it("nested containers re-flow outward", async () => {
    const { api, clock } = await setup();
    const inner = run(api, (d) =>
      makeContainer(d, ["A", "B"], { direction: "horizontal", gap: 10, padding: 0 }),
    );
    const outer = run(api, (d) =>
      makeContainer(d, [inner.containerId, "A", "B", "C"], { gap: 10, padding: 0 }),
    );
    clock.frame();
    expect(pos(api, "C").y).toBe(70);
    userEdit(api, { B: { height: 100 } });
    clock.frame();
    expect(pos(api, inner.containerId).h).toBe(100);
    expect(pos(api, "C").y).toBe(110);
    expect(pos(api, outer.containerId).h).toBe(140);
  });
});

describe("components interplay", () => {
  it("a container inside a master re-flows and its instances follow", async () => {
    const { api, clock } = await setup();
    const made = run(api, (d) => makeContainer(d, ["A", "B"], { gap: 10, padding: 0 }));
    let comp: ReturnType<typeof createComponent> | null = null;
    let inst: ReturnType<typeof insertInstance> | null = null;
    act(() => {
      comp = runContainerCommand(api, (d) =>
        createComponent(d, [made.containerId, "A", "B"], "Stack"),
      );
    });
    act(() => {
      inst = runContainerCommand(api, (d) =>
        insertInstance(d, comp!.componentId, { x: 0, y: 500 }),
      );
    });
    clock.frame();
    const copyOf = (slot: string) =>
      all(api).find((e) => {
        const t = tagOf(e);
        return (
          !e.isDeleted &&
          t?.role === "instance" &&
          groupOf(e, t) === inst!.groupId &&
          t.slot === slot
        );
      })!;
    const b0 = copyOf("B").y;
    userEdit(api, { A: { height: 90 } });
    clock.frame();
    expect(pos(api, "B").y).toBe(100);
    // Same reactor pass: the master's re-flow reached the instance.
    expect(copyOf("B").y - b0).toBe(50);
    expect(copyOf(made.containerId).height).toBe(pos(api, made.containerId).h);
  });

  it("an instance is one child; moving it doesn't create overrides", async () => {
    const { api, clock } = await setup();
    const comp = run(api, (d) => createComponent(d, ["X"], "Dot"));
    const inst = run(api, (d) => insertInstance(d, comp.componentId, { x: 900, y: 900 }));
    clock.frame();
    const made = run(api, (d) => makeContainer(d, ["A", "B"], { gap: 10, padding: 0 }));
    run(api, (d) => addToContainer(d, made.containerId, inst.ids));
    clock.frame();
    const copy = all(api).find((e) => inst.ids.includes(e.id) && e.type === "rectangle")!;
    expect(copy).toMatchObject({ x: 0, y: 120 });
    expect(tagOf(copy)?.overrides ?? {}).toEqual({});
    // Editing the master still syncs into the (moved) instance.
    userEdit(api, { X: { width: 70 } });
    clock.frame();
    expect(get(api, copy.id)).toMatchObject({ x: 0, y: 120, width: 70 });
  });
});
