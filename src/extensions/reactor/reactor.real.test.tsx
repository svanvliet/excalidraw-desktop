// Reactor spike (docs/reactor-spike.md) against the REAL Excalidraw 0.18.1 Store/History in jsdom.
// Points 1 (undo/redo), 4 (overridden text re-measure) and 5 (duplicate → instance, arrow
// bindings), plus the loop guard and idempotency.
import "../../agent/scene/testHarness";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type {
  ExcalidrawArrowElement,
  ExcalidrawTextElement,
} from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { createReactor, type El, type Reactor, type ReactorRule } from "./reactor";
import { mirrorLinkOf, mirrorRule, withMirrorLink, type MirrorLink } from "./mirrorRule";
import { mirrorOnDuplicate } from "./duplicate";

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

let reactor: Reactor | null = null;
afterEach(() => {
  reactor?.dispose();
  reactor = null;
  cleanup();
});

/** Manual scheduler: tests decide when a frame happens. */
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

/** Source "S" (labelled) at (0,0) and two instances "T1" (dy 200) and "T2" (dx 300). */
function fixture(opts: { overrideText?: string; arrowToT1?: boolean } = {}): El[] {
  const skel: ExcalidrawElementSkeleton[] = [
    {
      type: "rectangle",
      id: "S",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      label: { text: "Master" },
    },
    {
      type: "rectangle",
      id: "T1",
      x: 0,
      y: 200,
      width: 200,
      height: 80,
      label: { text: "Master" },
    },
    {
      type: "rectangle",
      id: "T2",
      x: 300,
      y: 0,
      width: 200,
      height: 80,
      label: { text: "Master" },
    },
  ] as ExcalidrawElementSkeleton[];
  if (opts.arrowToT1)
    skel.push({
      type: "arrow",
      id: "A",
      x: -200,
      y: 240,
      width: 186,
      height: 0,
      start: { type: "ellipse", id: "E", x: -300, y: 220, width: 40, height: 40 },
      end: { id: "T1" },
    } as ExcalidrawElementSkeleton);
  const els = convertToExcalidrawElements(skel, { regenerateIds: false });
  const textOf = (id: string) => els.find((e) => (e as ExcalidrawTextElement).containerId === id)!;
  const links = new Map<string, MirrorLink>([
    ["S", { role: "source", key: "box" }],
    [textOf("S").id, { role: "source", key: "label" }],
    ["T1", { role: "target", key: "box", dx: 0, dy: 200 }],
    [
      textOf("T1").id,
      {
        role: "target",
        key: "label",
        dx: 0,
        dy: 200,
        ...(opts.overrideText ? { overrides: { text: opts.overrideText } } : {}),
      },
    ],
    ["T2", { role: "target", key: "box", dx: 300, dy: 0 }],
    [textOf("T2").id, { role: "target", key: "label", dx: 300, dy: 0 }],
  ]);
  return els.map((e) => (links.has(e.id) ? withMirrorLink(e, links.get(e.id)!) : e));
}

async function mount(elements: El[], props: { onDuplicate?: typeof mirrorOnDuplicate } = {}) {
  let api: ExcalidrawImperativeAPI | null = null;
  render(
    <Excalidraw
      excalidrawAPI={(a) => (api = a)}
      initialData={{ elements }}
      onDuplicate={props.onDuplicate}
    />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return api as unknown as ExcalidrawImperativeAPI;
}

const get = (api: ExcalidrawImperativeAPI, id: string) =>
  api.getSceneElementsIncludingDeleted().find((e) => e.id === id)!;
const textIn = (api: ExcalidrawImperativeAPI, containerId: string) =>
  api
    .getSceneElements()
    .find((e) => (e as ExcalidrawTextElement).containerId === containerId) as ExcalidrawTextElement;
const button = (label: "Undo" | "Redo") =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const click = (label: "Undo" | "Redo") => act(() => void fireEvent.click(button(label)));
/** Real key press on the canvas container (handleKeyboardGlobally is off). */
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    const el = document.querySelector(".excalidraw")!;
    fireEvent.keyDown(el, { key: k, ...init });
    fireEvent.keyUp(el, { key: k, ...init });
  });
const select = (api: ExcalidrawImperativeAPI, ...ids: string[]) =>
  act(() =>
    api.updateScene({
      appState: { selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])) },
      captureUpdate: CaptureUpdateAction.NEVER,
    }),
  );
/** A user edit: one captured history entry. */
const userEdit = (api: ExcalidrawImperativeAPI, id: string, patch: Record<string, unknown>) =>
  act(() =>
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((e) =>
          e.id === id
            ? { ...e, ...patch, version: e.version + 1, versionNonce: e.versionNonce + 1 }
            : e,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    }),
  );

describe("point 1 — undo/redo with derived targets", () => {
  it("one undo/redo restores source and targets; reactor writes add no history and keep redo", async () => {
    const api = await mount(fixture());
    const clock = manualSchedule();
    reactor = createReactor({ api, rules: [mirrorRule], schedule: clock.schedule });
    expect(button("Undo").disabled).toBe(true);

    // Two quick captured edits before the frame: one flush (throttled).
    userEdit(api, "S", { x: 5 });
    userEdit(api, "S", { y: 5 });
    expect(clock.scheduled()).toBe(1);
    clock.frame();
    expect(get(api, "T1")).toMatchObject({ x: 5, y: 205 });
    expect(get(api, "T2")).toMatchObject({ x: 305, y: 5 });
    // The reactor's own writes were recognised and did not schedule another frame.
    expect(clock.scheduled()).toBe(0);
    expect(reactor.stats.ignored).toBe(reactor.stats.patched);

    click("Undo");
    click("Undo");
    expect(get(api, "S")).toMatchObject({ x: 0, y: 0 });
    // History restores the source only; the targets follow on the next frame.
    clock.frame();
    expect(get(api, "T1")).toMatchObject({ x: 0, y: 200 });
    expect(get(api, "T2")).toMatchObject({ x: 300, y: 0 });
    // Exactly the two nudges were in history: nothing the reactor wrote got its own entry …
    expect(button("Undo").disabled).toBe(true);
    // … and the NEVER apply after undo did not clear the redo stack.
    expect(button("Redo").disabled).toBe(false);

    click("Redo");
    click("Redo");
    clock.frame();
    expect(get(api, "S")).toMatchObject({ x: 5, y: 5 });
    expect(get(api, "T1")).toMatchObject({ x: 5, y: 205 });
    expect(get(api, "T2")).toMatchObject({ x: 305, y: 5 });
    expect(button("Redo").disabled).toBe(true);
    expect(button("Undo").disabled).toBe(false);

    click("Undo");
    clock.frame();
    expect(get(api, "T1")).toMatchObject({ x: 5, y: 200 });
    expect(reactor.stats.loopGuardHits).toBe(0);
  });

  it("arrow-key nudges (EVENTUALLY in 0.18.1) fold into the next entry; targets still follow", async () => {
    const api = await mount(fixture());
    const clock = manualSchedule();
    reactor = createReactor({ api, rules: [mirrorRule], schedule: clock.schedule });
    select(api, "S");
    key("ArrowRight", { shiftKey: true }); // ELEMENT_SHIFT_TRANSLATE_AMOUNT = 5
    key("ArrowDown", { shiftKey: true });
    expect(get(api, "S")).toMatchObject({ x: 5, y: 5 });
    expect(textIn(api, "S").x).toBeGreaterThan(5); // bound text moved with it
    clock.frame();
    expect(get(api, "T1")).toMatchObject({ x: 5, y: 205 });
    expect(textIn(api, "T1").x).toBe(textIn(api, "S").x);
    expect(textIn(api, "T1").y).toBe(textIn(api, "S").y + 200);
    // Upstream: nudges aren't captured until the next IMMEDIATELY action.
    expect(button("Undo").disabled).toBe(true);
    // Note: updateScene(IMMEDIATELY) can't commit it either — it filters elements with
    // uncommitted local edits. The next *UI* action does: bring-forward (Ctrl+]).
    key("]", { code: "BracketRight", ctrlKey: true });
    clock.frame();
    expect(button("Undo").disabled).toBe(false);
    click("Undo"); // nudges + reorder, as Excalidraw lumps them
    clock.frame();
    expect(get(api, "S")).toMatchObject({ x: 0, y: 0 });
    // The reactor's NEVER writes went into the snapshot, not the entry: targets are re-derived.
    expect(get(api, "T1")).toMatchObject({ x: 0, y: 200 });
    expect(textIn(api, "T1").y).toBe(textIn(api, "S").y + 200);
    expect(button("Undo").disabled).toBe(true);
    click("Redo");
    clock.frame();
    expect(get(api, "T1")).toMatchObject({ x: 5, y: 205 });
  });

  it("a style edit is one entry; undo restores the derived style", async () => {
    const api = await mount(fixture());
    const clock = manualSchedule();
    reactor = createReactor({ api, rules: [mirrorRule], schedule: clock.schedule });
    userEdit(api, "S", { backgroundColor: "#ffc9c9", strokeWidth: 4 });
    clock.frame();
    expect(get(api, "T2")).toMatchObject({ backgroundColor: "#ffc9c9", strokeWidth: 4 });
    click("Undo");
    clock.frame();
    expect(get(api, "T2")).toMatchObject({ backgroundColor: "transparent", strokeWidth: 2 });
    expect(button("Undo").disabled).toBe(true);
    click("Redo");
    clock.frame();
    expect(get(api, "T2")).toMatchObject({ backgroundColor: "#ffc9c9", strokeWidth: 4 });
  });

  it("re-derives a target that undo/redo touched directly (no drift)", async () => {
    const api = await mount(fixture());
    const clock = manualSchedule();
    reactor = createReactor({ api, rules: [mirrorRule], schedule: clock.schedule });
    // A direct edit of a target is reverted on the next frame (overrides are explicit data).
    userEdit(api, "T1", { x: 999 });
    clock.frame();
    expect(get(api, "T1").x).toBe(0);
  });
});

describe("point 4 — overridden text re-measures without unexported helpers", () => {
  it("wraps and centres the override when the source container narrows", async () => {
    const override = "a considerably longer override label";
    const api = await mount(fixture({ overrideText: override }));
    const clock = manualSchedule();
    reactor = createReactor({ api, rules: [mirrorRule], schedule: clock.schedule });
    userEdit(api, "S", { width: 120 });
    clock.frame();
    const t1 = get(api, "T1");
    const text = textIn(api, "T1");
    expect(t1.width).toBe(120);
    expect(text.originalText).toBe(override);
    expect(text.text).toContain("\n"); // wrapped
    // BOUND_TEXT_PADDING = 5 on each side.
    expect(text.width).toBeLessThanOrEqual(120 - 10);
    expect(text.x + text.width / 2).toBeCloseTo(t1.x + t1.width / 2, 5);
    // The non-overridden instance mirrors the source text exactly.
    expect(textIn(api, "T2").text).toBe(textIn(api, "S").text);
    // Same measurement Excalidraw makes for a native label of that size: compare with a skeleton.
    const [, native] = convertToExcalidrawElements([
      {
        type: "rectangle",
        x: t1.x,
        y: t1.y,
        width: 120,
        height: t1.height,
        label: { text: override },
      },
    ] as ExcalidrawElementSkeleton[]) as [El, ExcalidrawTextElement];
    expect(text.text).toBe(native.text);
    expect(text.width).toBe(native.width);
  });
});

describe("point 5 — duplicate → instance, arrow bindings", () => {
  it("Ctrl+D of a source makes the copy an instance in one undo step", async () => {
    const api = await mount(fixture(), { onDuplicate: mirrorOnDuplicate });
    const clock = manualSchedule();
    reactor = createReactor({ api, rules: [mirrorRule], schedule: clock.schedule });
    select(api, "S");
    key("d", { ctrlKey: true });
    const known = new Set(["S", "T1", "T2"]);
    const copy = api.getSceneElements().find((e) => e.type === "rectangle" && !known.has(e.id))!;
    expect(copy).toBeTruthy();
    expect(mirrorLinkOf(copy)).toMatchObject({ role: "target", key: "box" });
    expect(mirrorLinkOf(textIn(api, copy.id))).toMatchObject({ role: "target", key: "label" });
    clock.frame();
    const dx = copy.x - get(api, "S").x;

    userEdit(api, "S", { backgroundColor: "#a5d8ff", x: 40 });
    clock.frame();
    expect(get(api, copy.id)).toMatchObject({ backgroundColor: "#a5d8ff", x: 40 + dx });

    click("Undo"); // the style/move edit
    click("Undo"); // the duplicate — a single entry including the onDuplicate mapping
    clock.frame();
    expect(get(api, copy.id).isDeleted).toBe(true);
    expect(button("Undo").disabled).toBe(true);
  });

  it("an orphan copy (its source isn't in the scene) stays a source", () => {
    const [s] = fixture();
    const copy = { ...s, id: "copy" } as El;
    expect(mirrorOnDuplicate([copy], [])).toBeUndefined();
    expect(mirrorLinkOf(copy)).toMatchObject({ role: "source" });
  });

  it("arrows bound to a derived target keep their binding and follow it", async () => {
    const api = await mount(fixture({ arrowToT1: true }));
    const clock = manualSchedule();
    reactor = createReactor({ api, rules: [mirrorRule], schedule: clock.schedule });
    const before = get(api, "A") as ExcalidrawArrowElement;
    expect(before.endBinding?.elementId).toBe("T1");
    const endBefore = before.points[before.points.length - 1];
    const startBefore = before.points[0];

    userEdit(api, "S", { x: 100, width: 300 });
    clock.frame();
    const t1 = get(api, "T1");
    const a = get(api, "A") as ExcalidrawArrowElement;
    expect(t1.boundElements).toContainEqual({ id: "A", type: "arrow" });
    expect(a.endBinding?.elementId).toBe("T1");
    expect(a.startBinding?.elementId).toBe(before.startBinding?.elementId);
    // The start (bound to an untouched ellipse) stays put; the end moved with T1.
    expect(a.x + a.points[0][0]).toBeCloseTo(before.x + startBefore[0]);
    const endX = a.x + a.points[a.points.length - 1][0];
    expect(endX).toBeGreaterThan(before.x + endBefore[0] + 99);
    // Still at T1's left edge, keeping the binding gap.
    expect(endX).toBeCloseTo(t1.x + (before.x + endBefore[0]));
    expect(endX).toBeLessThanOrEqual(t1.x + t1.width);

    // Undo restores the arrow too (reactor re-derives it from the restored target box).
    click("Undo");
    clock.frame();
    const back = get(api, "A") as ExcalidrawArrowElement;
    expect(back.x + back.points[back.points.length - 1][0]).toBeCloseTo(before.x + endBefore[0]);
    expect(back.endBinding?.elementId).toBe("T1");
  });
});

describe("loop guard and idempotency", () => {
  it("stops self-feeding chains and never writes no-op patches", async () => {
    const api = await mount(fixture());
    const clock = manualSchedule();
    // A pathological rule: the target is also its own key's source and keeps moving itself.
    const runaway: ReactorRule = {
      name: "runaway",
      links: (el) =>
        el.id === "T2"
          ? [
              { role: "target", key: "loop" },
              { role: "source", key: "loop" },
            ]
          : el.id === "S"
            ? [{ role: "source", key: "kick" }]
            : el.id === "T1"
              ? [
                  { role: "target", key: "kick" },
                  { role: "source", key: "loop" },
                ]
              : [],
      derive: (target, source) =>
        target.id === "T2" ? { x: target.x + 1 } : { y: source.y + 200 },
    };
    reactor = createReactor({ api, rules: [runaway], schedule: clock.schedule });
    userEdit(api, "S", { y: 1 });
    clock.frame();
    expect(get(api, "T2").x).toBe(301); // written once per flush, never twice
    expect(reactor.stats.loopGuardHits).toBeGreaterThan(0);
    expect(clock.scheduled()).toBe(0); // its own write doesn't re-trigger

    const flushes = reactor.stats.flushes;
    const patched = reactor.stats.patched;
    reactor.flush(); // nothing dirty
    expect(reactor.stats).toMatchObject({ flushes, patched });
  });

  it("an edit that derives no change writes nothing", async () => {
    const api = await mount(fixture());
    const clock = manualSchedule();
    reactor = createReactor({ api, rules: [mirrorRule], schedule: clock.schedule });
    userEdit(api, "S", { locked: true }); // not a mirrored prop
    clock.frame();
    expect(reactor.stats.patched).toBe(0);
    expect(get(api, "T1").locked).toBe(false);
  });
});
