import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../agent/scene/testHarness";
import {
  endAnchors,
  nearestDot,
  outlinePoint,
  PIN_KEY,
  pinnedPatch,
  pinOf,
  snapDots,
  snapPatches,
  withPin,
} from "./lineAnchors";

void FakeApi; // imported for its jsdom canvas/font stubs

type El = ExcalidrawElement;

const shape = (id: string, over: Partial<El> = {}): El =>
  ({
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    isDeleted: false,
    boundElements: null,
    customData: undefined,
    ...over,
  }) as unknown as El;

const arrow = (over: Record<string, unknown> = {}): El =>
  ({
    id: "a",
    type: "arrow",
    x: 300,
    y: 25,
    width: 100,
    height: 0,
    angle: 0,
    points: [
      [0, 0],
      [-100, 0],
    ],
    isDeleted: false,
    startBinding: null,
    endBinding: null,
    customData: undefined,
    ...over,
  }) as unknown as El;

const close = (p: readonly number[], q: readonly number[]) => {
  // face midpoints sit at 0.5001 (elbowAnchors' HALF), hence the loose precision.
  expect(p[0]).toBeCloseTo(q[0], 1);
  expect(p[1]).toBeCloseTo(q[1], 1);
};

describe("snapDots", () => {
  it("puts dots on the face midpoints and centre", () => {
    const dots = Object.fromEntries(snapDots(shape("r")).map((d) => [d.anchor, d.point]));
    close(dots.n, [50, 0]);
    close(dots.e, [100, 25]);
    close(dots.s, [50, 50]);
    close(dots.w, [0, 25]);
    close(dots.center, [50, 25]);
  });

  it("rotates with the shape", () => {
    const dots = Object.fromEntries(
      snapDots(shape("r", { angle: Math.PI / 2 } as Partial<El>)).map((d) => [d.anchor, d.point]),
    );
    // centre (50,25); the east face (+50,0) rotates a quarter turn to (0,+50).
    close(dots.e, [50, 75]);
    close(dots.n, [75, 25]);
  });
});

describe("nearestDot", () => {
  it("finds the closest dot within the tolerance", () => {
    const hit = nearestDot([shape("r")], [104, 27], 12);
    expect(hit?.anchor).toBe("e");
    expect(nearestDot([shape("r")], [130, 25], 12)).toBeNull();
  });

  it("prefers the already-bound shape when two dots are in range", () => {
    const a = shape("a");
    const b = shape("b", { x: 106 } as Partial<El>);
    expect(nearestDot([a, b], [102, 25], 12)?.shape.id).toBe("a");
    expect(nearestDot([a, b], [102, 25], 12, "b")?.shape.id).toBe("b");
  });

  it("ignores text inside containers and deleted shapes", () => {
    const t = shape("t", { type: "text", containerId: "r" } as unknown as Partial<El>);
    const d = shape("d", { isDeleted: true } as Partial<El>);
    expect(nearestDot([t, d], [50, 0], 12)).toBeNull();
  });
});

describe("outlinePoint", () => {
  it("leaves rectangles, ellipses and diamonds on their outline plus the gap", () => {
    close(outlinePoint(shape("r"), [500, 25], 5), [105, 25]);
    close(outlinePoint(shape("e", { type: "ellipse" } as Partial<El>), [50, -500], 5), [50, -5]);
    const d = outlinePoint(
      shape("d", { type: "diamond", height: 100 } as Partial<El>),
      [150, 150],
      0,
    );
    // the ray toward the bottom-right corner meets the diamond's edge at the midpoint.
    close(d, [75, 75]);
  });
});

describe("pins", () => {
  it("sets and clears an end's pin in customData", () => {
    const a = arrow({ customData: { keep: 1 } });
    const data = withPin(a, "end", { id: "r", anchor: "e" });
    expect(data).toEqual({ keep: 1, [PIN_KEY]: { end: { id: "r", anchor: "e" } } });
    const pinned = arrow({ customData: data });
    expect(withPin(pinned, "end", { id: "r", anchor: "e" })).toBe(data);
    expect(withPin(pinned, "end", null)).toEqual({ keep: 1 });
  });

  it("only reports an end's anchor while it's still bound to the pinned shape", () => {
    const data = { [PIN_KEY]: { end: { id: "r", anchor: "e" } } };
    expect(endAnchors(arrow({ customData: data }) as never).end).toBeNull();
    const bound = arrow({ customData: data, endBinding: { elementId: "r", focus: 0, gap: 5 } });
    expect(endAnchors(bound as never)).toEqual({ start: null, end: "e" });
  });
});

describe("pinnedPatch", () => {
  const r = shape("r");
  const get = (id: string) => (id === "r" ? r : undefined);

  it("moves a pinned end back onto its face midpoint", () => {
    const a = arrow({
      customData: { [PIN_KEY]: { end: { id: "r", anchor: "e" } } },
      endBinding: { elementId: "r", focus: 0.3, gap: 12 },
    });
    const patch = pinnedPatch(a as never, get)!;
    close([patch.x + patch.points[1][0], patch.y + patch.points[1][1]], [105, 25]);
    expect(patch.endBinding).toMatchObject({ elementId: "r", gap: 5 });
    expect(patch.endBinding!.focus).toBeCloseTo(0, 3);
  });

  it("returns null when the end is already pinned", () => {
    const a = arrow({
      points: [
        [0, 0],
        [-195, 0],
      ],
      customData: { [PIN_KEY]: { end: { id: "r", anchor: "e" } } },
      endBinding: { elementId: "r", focus: 0, gap: 5 },
    });
    expect(pinnedPatch(a as never, get)).toBeNull();
  });

  it("leaves an end alone once it's bound elsewhere", () => {
    const a = arrow({
      customData: { [PIN_KEY]: { end: { id: "r", anchor: "e" } } },
      endBinding: { elementId: "other", focus: 0, gap: 5 },
    });
    expect(pinnedPatch(a as never, get)).toBeNull();
  });
});

describe("snapPatches", () => {
  it("binds, pins and updates boundElements for a straight arrow", () => {
    const r = shape("r");
    const old = shape("old", { boundElements: [{ id: "a", type: "arrow" }] } as Partial<El>);
    const a = arrow({ endBinding: { elementId: "old", focus: 0, gap: 5 } });
    const get = (id: string) => ({ r, old })[id as "r" | "old"];
    const out = snapPatches(a as never, "end", { shape: r, anchor: "n" }, get);
    expect(out.get("old")).toEqual({ boundElements: [] });
    expect(out.get("r")).toEqual({ boundElements: [{ id: "a", type: "arrow" }] });
    const p = out.get("a")! as { x: number; y: number; points: number[][]; customData: unknown };
    close([p.x + p.points[1][0], p.y + p.points[1][1]], [50, -5]);
    expect(pinOf({ customData: p.customData } as El).end).toEqual({ id: "r", anchor: "n" });
  });

  it("sets a fixedPoint for elbow arrows instead of a pin", () => {
    const r = shape("r");
    const a = arrow({ elbowed: true });
    const out = snapPatches(a as never, "end", { shape: r, anchor: "s" }, () => r);
    const p = out.get("a") as { endBinding: { fixedPoint: number[] }; customData?: unknown };
    expect(p.endBinding.fixedPoint[0]).toBeCloseTo(0.5, 2);
    expect(p.endBinding.fixedPoint[1]).toBeGreaterThan(1);
    expect(p.customData).toBeUndefined();
  });

  it("clears the pin when the target is null", () => {
    const a = arrow({ customData: { [PIN_KEY]: { start: { id: "r", anchor: "w" } } } });
    expect(snapPatches(a as never, "start", null, () => undefined).get("a")).toEqual({
      customData: {},
    });
  });
});
