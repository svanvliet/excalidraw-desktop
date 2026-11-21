import { FakeApi } from "../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElbowArrowElement } from "@excalidraw/excalidraw/element/types";
import {
  anchorBindings,
  anchorPoint,
  facingSide,
  fixedPointFor,
  isElbowArrow,
  routedElbow,
  SIDES,
  sideOf,
} from "./elbowAnchors";

void FakeApi; // imported for its jsdom canvas/font stubs

const box = { x: 0, y: 0, width: 100, height: 50, angle: 0 };

function elbowScene() {
  return convertToExcalidrawElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "b", x: 300, y: 200, width: 100, height: 50 },
      {
        type: "arrow",
        id: "x",
        elbowed: true,
        x: 100,
        y: 25,
        start: { id: "a" },
        end: { id: "b" },
      },
    ] as unknown as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
}

describe("elbow anchors", () => {
  it("places each side's fixedPoint FIXED_BINDING_DISTANCE outside the box", () => {
    expect(fixedPointFor("n", box)).toEqual([0.5001, -0.1]);
    expect(fixedPointFor("e", box)).toEqual([1.05, 0.5001]);
    expect(fixedPointFor("s", box)).toEqual([0.5001, 1.1]);
    expect(fixedPointFor("w", box)).toEqual([-0.05, 0.5001]);
    for (const side of SIDES) expect(sideOf(fixedPointFor(side, box))).toBe(side);
    expect(sideOf([0.3, -0.1])).toBeNull();
    expect(sideOf(null)).toBeNull();
    expect(anchorPoint("n", box)).toEqual([50.01, -5]);
  });

  it("picks the facing side relative to the box's size and rotation", () => {
    expect(facingSide(box, [300, 60])).toBe("e");
    expect(facingSide(box, [60, -300])).toBe("n");
    // A wide box: a target down and to the right by equal amounts faces the bottom.
    expect(facingSide({ ...box, width: 400 }, [400, 225])).toBe("s");
    // Rotated 90° clockwise, the world's right is the box's top.
    expect(facingSide({ ...box, angle: Math.PI / 2 }, [300, 25])).toBe("n");
  });

  it("builds fixedPoint bindings, resolving center to the side facing the other end", () => {
    const els = elbowScene();
    const byId = new Map(els.map((e) => [e.id, e]));
    const arrow = byId.get("x")!;
    expect(isElbowArrow(arrow)).toBe(true);
    const b = anchorBindings(
      arrow as ExcalidrawElbowArrowElement,
      { start: "s", end: "center" },
      (id) => byId.get(id),
    );
    expect(b.startBinding).toMatchObject({ elementId: "a", fixedPoint: [0.5001, 1.1] });
    // b is 300 left and 200 above, but 200 is 4 heights vs 3 widths: the top faces a.
    expect(sideOf(b.endBinding!.fixedPoint)).toBe("n");
    expect(() =>
      anchorBindings(
        { ...(arrow as ExcalidrawElbowArrowElement), endBinding: null },
        { end: "n" },
        (id) => byId.get(id),
      ),
    ).toThrow(/end isn't bound/);
  });

  it("routes into a new version and leaves the live element untouched", () => {
    const arrow = elbowScene().find((e) => e.id === "x") as ExcalidrawElbowArrowElement;
    const before = JSON.stringify(arrow);
    const next = routedElbow(arrow, {
      startBinding: { ...arrow.startBinding!, fixedPoint: fixedPointFor("n", box) as never },
    });
    expect(JSON.stringify(arrow)).toBe(before);
    expect(next).not.toBe(arrow);
    expect(next.version).toBeGreaterThan(arrow.version);
    expect(sideOf(next.startBinding!.fixedPoint)).toBe("n");
  });
});
