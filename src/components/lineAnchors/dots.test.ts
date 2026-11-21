import { describe, expect, it } from "vitest";
import { FakeApi } from "../../agent/scene/testHarness";
import { dotsNear } from "./dots";

void FakeApi; // jsdom canvas/font stubs for the Excalidraw import

const rect = (id: string, x: number) =>
  ({ id, type: "rectangle", x, y: 0, width: 100, height: 60, angle: 0, isDeleted: false }) as never;

const api = (zoom = 1) => ({
  getSceneElements: () => [rect("A", 0), rect("B", 1000)],
  getAppState: () =>
    ({ zoom: { value: zoom }, scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0 }) as never,
});

describe("dotsNear", () => {
  it("shows the dots of shapes near the pointer and highlights the snap target", () => {
    const dots = dotsNear(api(), { arrowId: null }, { x: 104, y: 33 });
    expect(dots.map((d) => d.key).sort()).toEqual(["A:center", "A:e", "A:n", "A:s", "A:w"].sort());
    expect(dots.filter((d) => d.active).map((d) => d.key)).toEqual(["A:e"]);
  });

  it("uses a screen-space tolerance", () => {
    // 20 scene px off the east midpoint: out of range at 1x, within 12 screen px at 0.5x.
    const at = (zoom: number) =>
      dotsNear(api(zoom), { arrowId: null }, { x: 120 * zoom, y: 30 * zoom }).some((d) => d.active);
    expect(at(1)).toBe(false);
    expect(at(0.5)).toBe(true);
  });
});
