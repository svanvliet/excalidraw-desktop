import "../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { boundsOf, Draft, ToolError, type El, type LinearEl } from "../agent/scene/draft";

type FP = { fixedPoint?: [number, number] };
const fp = (b: unknown) => (b as FP).fixedPoint;
import { fixedPointFor, sideOf } from "../lib/elbowAnchors";
import { PIN_KEY } from "../lib/lineAnchors";
import { pathCrossesBox, type Pt } from "./route";
import { fixedSegmentsFor, tidyArrowsDraft } from "./tidy";

function scene(skeletons: Array<Record<string, unknown>>, elbowed = true): El[] {
  const els = convertToExcalidrawElements(skeletons as unknown as ExcalidrawElementSkeleton[], {
    regenerateIds: false,
  });
  return els.map((e) =>
    e.type === "arrow" && elbowed ? ({ ...e, elbowed: true, roundness: null } as El) : e,
  );
}

const card = (id: string, x: number, y: number) => ({
  type: "rectangle",
  id,
  x,
  y,
  width: 120,
  height: 60,
  label: { text: id },
});
const arrow = (id: string, from: string, to: string) => ({
  type: "arrow",
  id,
  x: 0,
  y: 0,
  start: { id: from },
  end: { id: to },
});

/** CEO over three reports, with a sticky note sitting right where the straight lines would go. */
function orgChart(elbowed = true): El[] {
  return scene(
    [
      card("ceo", 400, 0),
      card("vp1", 100, 300),
      card("vp2", 400, 300),
      card("vp3", 700, 300),
      card("note", 230, 150),
      arrow("a1", "ceo", "vp1"),
      arrow("a2", "ceo", "vp2"),
      arrow("a3", "ceo", "vp3"),
    ],
    elbowed,
  );
}

const absPoints = (a: LinearEl): Pt[] => a.points.map(([x, y]) => [a.x + x, a.y + y]);

function expectClean(d: Draft, ids: string[]) {
  const cards = d.live().filter((e) => e.type === "rectangle");
  for (const id of ids) {
    const a = d.get(id) as LinearEl;
    const pts = absPoints(a);
    for (let i = 1; i < pts.length; i++) {
      const [[x0, y0], [x1, y1]] = [pts[i - 1], pts[i]];
      expect(x0 === x1 || y0 === y1).toBe(true);
    }
    const ends = new Set([a.startBinding!.elementId, a.endBinding!.elementId]);
    for (const c of cards) {
      if (!ends.has(c.id)) expect(pathCrossesBox(pts, boundsOf(c)), `${id} × ${c.id}`).toBe(false);
    }
  }
}

describe("tidyArrowsDraft", () => {
  it("routes an org chart around the note, sharing the CEO's trunk", () => {
    const d = new Draft(orgChart());
    const summary = tidyArrowsDraft(d);
    expect(summary.routed.sort()).toEqual(["a1", "a2", "a3"]);
    expect(summary.skipped).toEqual([]);
    expectClean(d, ["a1", "a2", "a3"]);
    const starts = ["a1", "a2", "a3"].map((id) => absPoints(d.get(id) as LinearEl)[0]);
    expect(new Set(starts.map((p) => p.join()))).toHaveProperty("size", 1);
    for (const id of ["a1", "a2", "a3"]) {
      const a = d.get(id) as LinearEl & { fixedSegments: unknown; elbowed: boolean };
      expect(sideOf(fp(a.startBinding!))).toBe("s");
      expect(sideOf(fp(a.endBinding!))).toBe("n");
      expect(d.reroute.has(id)).toBe(false);
      if (a.points.length >= 4) expect(a.fixedSegments).toEqual(fixedSegmentsFor(a.points as Pt[]));
    }
  });

  it("keeps a pinned side", () => {
    const els = orgChart().map((e) =>
      e.id === "a1"
        ? ({
            ...e,
            startBinding: {
              ...(e as LinearEl).startBinding!,
              fixedPoint: fixedPointFor("w", { width: 120, height: 60 }),
            },
          } as unknown as El)
        : e,
    );
    const d = new Draft(els);
    tidyArrowsDraft(d);
    expect(sideOf(fp((d.get("a1") as LinearEl).startBinding))).toBe("w");
    expectClean(d, ["a1"]);
  });

  it("tidies only the selection's arrows", () => {
    const d = new Draft(orgChart());
    const before = d.get("a2");
    expect(tidyArrowsDraft(d, { ids: ["vp1"] }).routed).toEqual(["a1"]);
    expect(d.get("a2")).toBe(before);
  });

  it("leaves straight arrows alone unless asked to convert them", () => {
    const d = new Draft(orgChart(false));
    expect(() => tidyArrowsDraft(d)).toThrow(ToolError);
    const summary = tidyArrowsDraft(d, { convert: true });
    expect(summary.converted.sort()).toEqual(["a1", "a2", "a3"]);
    const a = d.get("a1") as LinearEl & { elbowed: boolean };
    expect(a.elbowed).toBe(true);
    expect(a.roundness).toBeNull();
    expectClean(d, ["a1", "a2", "a3"]);
  });

  it("keeps a straight arrow's face-centre pin as its side when converting", () => {
    const els = orgChart(false).map((e) =>
      e.id === "a1"
        ? ({ ...e, customData: { [PIN_KEY]: { start: { id: "ceo", anchor: "w" } } } } as El)
        : e,
    );
    const d = new Draft(els);
    tidyArrowsDraft(d, { convert: true });
    const a = d.get("a1") as LinearEl;
    expect(sideOf(fp(a.startBinding))).toBe("w");
    expect(a.customData?.[PIN_KEY]).toBeUndefined();
  });
});

describe("fixedSegmentsFor", () => {
  it("pins every segment except the first and last", () => {
    expect(
      fixedSegmentsFor([
        [0, 0],
        [0, 10],
        [50, 10],
      ]),
    ).toBeNull();
    expect(
      fixedSegmentsFor([
        [0, 0],
        [0, 10],
        [50, 10],
        [50, 20],
        [80, 20],
      ]),
    ).toEqual([
      { index: 2, start: [0, 10], end: [50, 10] },
      { index: 3, start: [50, 10], end: [50, 20] },
    ]);
  });
});
