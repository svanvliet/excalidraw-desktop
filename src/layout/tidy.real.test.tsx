// Tidy Arrows against the REAL Excalidraw 0.18.1 elbow arrows in jsdom: the route survives
// commit, a later move of a bound shape, and a save/load round trip; one undo reverts it.
import "../agent/scene/testHarness";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { convertToExcalidrawElements, Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { fixedPointFor, isElbowArrow, routedElbow } from "../lib/elbowAnchors";
import { tidyArrowsCanvas } from "./canvasAction";

type Api = ExcalidrawImperativeAPI;
type Arrow = { x: number; y: number; points: [number, number][]; elbowed?: boolean };

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

afterEach(() => cleanup());

const CARD = { width: 120, height: 60 };
const card = (id: string, x: number, y: number) => ({
  type: "rectangle",
  id,
  x,
  y,
  width: 120,
  height: 60,
});

function orgChart(elbowed: boolean) {
  const els = convertToExcalidrawElements(
    [
      card("ceo", 400, 0),
      card("vp1", 100, 300),
      card("vp3", 700, 300),
      card("note", 200, 140),
      { type: "arrow", id: "a1", x: 0, y: 0, start: { id: "ceo" }, end: { id: "vp1" } },
      { type: "arrow", id: "a3", x: 0, y: 0, start: { id: "ceo" }, end: { id: "vp3" } },
    ] as unknown as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
  // Like arrows drawn in Excalidraw: elbow ends snapped to the side midpoints.
  return els.map((e) =>
    e.type === "arrow" && elbowed
      ? {
          ...e,
          elbowed: true,
          startBinding: { ...e.startBinding!, fixedPoint: fixedPointFor("s", CARD) },
          endBinding: { ...e.endBinding!, fixedPoint: fixedPointFor("n", CARD) },
        }
      : e,
  );
}

async function mount(elements: unknown[]): Promise<Api> {
  let api: Api | null = null;
  render(
    <Excalidraw
      excalidrawAPI={(a) => (api = a)}
      initialData={{ elements: restoreElements(elements as never, null) }}
    />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return api!;
}

const get = (api: Api, id: string) =>
  api.getSceneElementsIncludingDeleted().find((e) => e.id === id)! as unknown as Arrow;
const abs = (a: Arrow) => a.points.map(([x, y]) => [a.x + x, a.y + y]);
const undo = () => act(() => void fireEvent.click(document.querySelector('[aria-label="Undo"]')!));

describe("Tidy Arrows on a real canvas", () => {
  it("keeps the route through commit, a shape move and a reload; one undo reverts", async () => {
    const api = await mount(orgChart(true));
    // Start from Excalidraw's own routes (through the note), as if the user had drawn them.
    act(() =>
      api.updateScene({
        elements: api
          .getSceneElementsIncludingDeleted()
          .map((e) => (isElbowArrow(e) ? routedElbow(e) : e)),
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    const before = abs(get(api, "a1"));
    act(() => void expect(tidyArrowsCanvas(api)).toBe(true));
    const tidy = abs(get(api, "a1"));
    expect(tidy).not.toEqual(before);
    expect(tidy.length).toBeGreaterThanOrEqual(4);

    // Reload: restore keeps points and bindings of an elbow with fixedPoints.
    const [restored] = restoreElements(
      [api.getSceneElements().find((e) => e.id === "a1")!],
      null,
    ) as unknown as Arrow[];
    expect(abs(restored)).toEqual(tidy);

    undo();
    expect(abs(get(api, "a1"))).toEqual(before);
    act(() => void tidyArrowsCanvas(api));
    expect(abs(get(api, "a1"))).toEqual(tidy);

    // Move the child the way Excalidraw does on drag: re-route the bound arrow with its
    // fixed segments. The interior (the bus) stays; only the last legs adapt.
    const vp1 = api.getSceneElements().find((e) => e.id === "vp1")!;
    act(() =>
      api.updateScene({
        elements: api
          .getSceneElementsIncludingDeleted()
          .map((e) => (e.id === "vp1" ? { ...vp1, x: vp1.x - 40, version: vp1.version + 1 } : e)),
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    const live = api.getSceneElements().find((e) => e.id === "a1")!;
    if (!isElbowArrow(live)) throw new Error("not elbow");
    const moved = abs(routedElbow(live) as unknown as Arrow);
    expect(moved.slice(1, 3)).toEqual(tidy.slice(1, 3));
  });

  it("converts straight arrows to elbows when asked, and undo restores them", async () => {
    const api = await mount(orgChart(false));
    act(() => void expect(tidyArrowsCanvas(api)).toBe(false));
    act(() => void expect(tidyArrowsCanvas(api, { convert: true })).toBe(true));
    expect(get(api, "a1").elbowed).toBe(true);
    undo();
    const a1 = get(api, "a1") as Arrow & { fixedSegments?: unknown };
    expect(a1.elbowed).toBe(false);
    expect(a1.fixedSegments ?? null).toBeNull();
  });
});
