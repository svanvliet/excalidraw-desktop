// Auto-layout against the REAL Excalidraw 0.18.1 elbow router in jsdom.
import "../agent/scene/testHarness";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import ElkBundled from "elkjs/lib/elk.bundled.js";
import { setElkFactory } from "./elk";
import { autoLayoutCanvas } from "./canvasAction";
import treeElbows from "./__fixtures__/tree-elbows.json";

type Api = ExcalidrawImperativeAPI;
type Arrow = { x: number; y: number; points: [number, number][] };

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

beforeAll(() => setElkFactory(async () => new ElkBundled()));
afterAll(() => setElkFactory(null));
afterEach(() => cleanup());

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

const PARENT = "-5lLerHKqlwxkk89arI4l";
const ARROWS = ["Xdy-B3wPSXMelFZtviKNN", "LcMX2muoKUdCXQ_1eNIli"];
const get = (api: Api, id: string) =>
  api.getSceneElementsIncludingDeleted().find((e) => e.id === id)!;

describe("auto-layout Tree with elbow arrows", () => {
  it("routes orthogonally from the parent's bottom to the children's tops, as one undo", async () => {
    const api = await mount(treeElbows);
    const before = ARROWS.map((id) => get(api, id));
    await act(async () => {
      expect(await autoLayoutCanvas(api, "tree")).toBe(true);
    });
    const parent = get(api, PARENT);
    for (const id of ARROWS) {
      const a = get(api, id) as unknown as Arrow & { endBinding: { elementId: string } };
      const abs = a.points.map(([x, y]) => [a.x + x, a.y + y]);
      for (let i = 1; i < abs.length; i++) {
        const [[x0, y0], [x1, y1]] = [abs[i - 1], abs[i]];
        expect(Math.abs(x0 - x1) < 0.5 || Math.abs(y0 - y1) < 0.5).toBe(true);
      }
      const child = get(api, a.endBinding.elementId);
      expect(abs[0][1]).toBeGreaterThanOrEqual(parent.y + parent.height);
      expect(abs[0][0]).toBeCloseTo(parent.x + parent.width / 2, 0);
      expect(abs[abs.length - 1][1]).toBeLessThanOrEqual(child.y);
      expect(abs[abs.length - 1][0]).toBeCloseTo(child.x + child.width / 2, 0);
    }
    act(() => void fireEvent.click(document.querySelector('[aria-label="Undo"]')!));
    ARROWS.forEach((id, i) => expect(get(api, id).x).toBeCloseTo(before[i].x, 3));
  });
});
