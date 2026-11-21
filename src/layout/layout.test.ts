import { FakeApi } from "../agent/scene/testHarness";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import ElkBundled from "elkjs/lib/elk.bundled.js";
import { boundsOf, Draft, edgePoint, type El, type LinearEl } from "../agent/scene/draft";
import { extractGraph, layoutTargets } from "./graph";
import { setElkFactory, toElkGraph } from "./elk";
import { autoLayoutDraft } from "./apply";
import { autoLayoutCanvas, isAutoLayoutShortcut } from "./canvasAction";

beforeAll(() => setElkFactory(async () => new ElkBundled()));
afterAll(() => setElkFactory(null));

function scene(skeletons: Array<Record<string, unknown>>): El[] {
  return convertToExcalidrawElements(skeletons as unknown as ExcalidrawElementSkeleton[], {
    regenerateIds: false,
  });
}

const box = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  type: "rectangle",
  id,
  x,
  y,
  width: 120,
  height: 60,
  ...extra,
});
const arrow = (id: string, from: string, to: string) => ({
  type: "arrow",
  id,
  x: 0,
  y: 0,
  start: { id: from },
  end: { id: to },
});

/** CEO → (CTO, CFO), CTO → Dev, all piled up in a messy row. */
function orgChart(): El[] {
  return scene([
    box("ceo", 400, 300, { label: { text: "CEO" } }),
    box("cto", 0, 0, { label: { text: "CTO" } }),
    box("cfo", 900, 10, { label: { text: "CFO" } }),
    box("dev", 300, 0, { label: { text: "Dev" } }),
    arrow("a1", "ceo", "cto"),
    arrow("a2", "ceo", "cfo"),
    arrow("a3", "cto", "dev"),
  ]);
}

const el = (d: Draft, id: string) => d.get(id)!;
const cx = (e: El) => e.x + e.width / 2;
const cy = (e: El) => e.y + e.height / 2;

/** The arrow's ends sit on its bound shapes' outlines (within the binding gap). */
function expectBoundEnds(d: Draft, id: string) {
  const a = el(d, id) as LinearEl;
  const pts = a.points.map(([x, y]) => [a.x + x, a.y + y]);
  const start = el(d, a.startBinding!.elementId);
  const end = el(d, a.endBinding!.elementId);
  const n = pts.length;
  const s = edgePoint(start, n > 2 ? pts[1] : [cx(end), cy(end)], a.startBinding!.gap);
  const e = edgePoint(end, n > 2 ? pts[n - 2] : [cx(start), cy(start)], a.endBinding!.gap);
  expect(pts[0][0]).toBeCloseTo(s[0], 3);
  expect(pts[0][1]).toBeCloseTo(s[1], 3);
  expect(pts[n - 1][0]).toBeCloseTo(e[0], 3);
  expect(pts[n - 1][1]).toBeCloseTo(e[1], 3);
}

describe("extractGraph", () => {
  it("maps shapes, groups and frames to nodes and bound arrows to edges", () => {
    const els = scene([
      box("a", 0, 0, { label: { text: "A" } }),
      box("g1", 300, 0, { groupIds: ["G"] }),
      box("g2", 450, 0, { groupIds: ["G"] }),
      { type: "frame", id: "f", x: 0, y: 300, width: 400, height: 300, children: ["in"] },
      box("in", 20, 340),
      {
        type: "line",
        id: "ln",
        x: 800,
        y: 0,
        points: [
          [0, 0],
          [50, 50],
        ],
      },
      arrow("ag", "a", "g1"),
      arrow("af", "g2", "in"),
      { type: "arrow", id: "half", x: 0, y: 0, start: { id: "a" }, end: undefined },
    ]);
    const half = els.find((e) => e.id === "half") as LinearEl;
    const draft = new Draft(els);
    expect(half.startBinding?.elementId).toBe("a");
    const g = extractGraph(draft, layoutTargets(draft));
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n.members.sort()]));
    expect(byId).toEqual({
      a: ["a"],
      "group:G": ["g1", "g2"],
      f: ["f", "in"],
      ln: ["ln"],
    });
    expect(g.edges.map((e) => [e.arrowId, e.source, e.target])).toEqual([
      ["ag", "a", "group:G"],
      ["af", "group:G", "f"],
    ]);
    expect([...g.attached]).toEqual([["half", "a"]]);
    const label = draft.boundTextOf(el(draft, "a"))!;
    expect(g.nodeOf.get(label.id)).toBe("a");
    // The frame node's box is the frame, the group's box spans both members.
    const groupNode = g.nodes.find((n) => n.id === "group:G")!;
    expect(groupNode.box).toEqual({ minX: 300, minY: 0, maxX: 570, maxY: 60 });
  });

  it("expands a selection to whole groups, frame children and bound text", () => {
    const draft = new Draft(
      scene([
        box("a", 0, 0, { label: { text: "A" } }),
        box("g1", 300, 0, { groupIds: ["G"] }),
        box("g2", 450, 0, { groupIds: ["G"] }),
        box("other", 0, 500),
      ]),
    );
    const ids = layoutTargets(draft, ["a", "g1"]).map((e) => e.id);
    const label = draft.boundTextOf(el(draft, "a"))!.id;
    expect(ids.sort()).toEqual(["a", "g1", "g2", label].sort());
  });

  it("feeds ELK siblings in their current visual order", () => {
    const draft = new Draft(orgChart());
    const g = extractGraph(draft, layoutTargets(draft));
    const elkGraph = toElkGraph(g, { direction: "down" });
    expect(elkGraph.children!.map((c) => c.id)).toEqual(["cto", "dev", "ceo", "cfo"]);
    expect(elkGraph.layoutOptions!["elk.direction"]).toBe("DOWN");
  });
});

describe("autoLayoutDraft", () => {
  it("lays out an org chart top-to-bottom with valid arrow bindings", async () => {
    const draft = new Draft(orgChart());
    const before = { x: 0, y: 0 };
    const summary = await autoLayoutDraft(draft, { direction: "down", spacing: 50 });
    expect(summary).toMatchObject({ nodes: 4, edges: 3 });
    const [ceo, cto, cfo, dev] = ["ceo", "cto", "cfo", "dev"].map((id) => el(draft, id));
    expect(cy(ceo)).toBeLessThan(cy(cto));
    expect(cy(cto)).toBeCloseTo(cy(cfo), 3);
    expect(cy(cto)).toBeLessThan(cy(dev));
    expect(cto.y - (ceo.y + ceo.height)).toBeGreaterThanOrEqual(50);
    expect(cx(cto)).toBeLessThan(cx(cfo));
    // Anchored at the original top-left corner.
    const all = ["ceo", "cto", "cfo", "dev"].map((id) => boundsOf(el(draft, id)));
    expect(Math.min(...all.map((b) => b.minX))).toBeCloseTo(before.x, 3);
    expect(Math.min(...all.map((b) => b.minY))).toBeCloseTo(before.y, 3);
    for (const a of ["a1", "a2", "a3"]) expectBoundEnds(draft, a);
    // Bound text moved with its container.
    const label = draft.boundTextOf(ceo)!;
    expect(cx(label)).toBeCloseTo(cx(ceo), 3);
    expect(cy(label)).toBeCloseTo(cy(ceo), 3);
  });

  it("lays out left-to-right", async () => {
    const draft = new Draft(orgChart());
    await autoLayoutDraft(draft, { direction: "right" });
    const [ceo, cto, cfo, dev] = ["ceo", "cto", "cfo", "dev"].map((id) => el(draft, id));
    expect(cx(ceo)).toBeLessThan(cx(cto));
    expect(cx(cto)).toBeCloseTo(cx(cfo), 3);
    expect(cx(cto)).toBeLessThan(cx(dev));
    for (const a of ["a1", "a2", "a3"]) expectBoundEnds(draft, a);
  });

  it("lays out a tree", async () => {
    const draft = new Draft(orgChart());
    await autoLayoutDraft(draft, { algorithm: "tree", direction: "down" });
    const [ceo, cto, cfo, dev] = ["ceo", "cto", "cfo", "dev"].map((id) => el(draft, id));
    expect(cy(ceo)).toBeLessThan(cy(cto));
    expect(cy(cto)).toBeCloseTo(cy(cfo), 3);
    expect(cy(cto)).toBeLessThan(cy(dev));
    for (const a of ["a1", "a2", "a3"]) expectBoundEnds(draft, a);
  });

  it("only moves the selection and re-routes arrows into it", async () => {
    const draft = new Draft(
      scene([
        box("a", 300, 0),
        box("b", 0, 400),
        box("c", 1000, 0),
        box("outside", 2000, 2000),
        arrow("ab", "a", "b"),
        arrow("bc", "b", "c"),
        arrow("out", "outside", "a"),
      ]),
    );
    const outside = el(draft, "outside");
    const a = el(draft, "a");
    await autoLayoutDraft(draft, { ids: ["a", "b", "c"] });
    expect(el(draft, "a").x).not.toBe(a.x);
    expect(el(draft, "outside")).toBe(outside);
    for (const a of ["ab", "bc", "out"]) expectBoundEnds(draft, a);
  });

  it("moves groups and frames as single units", async () => {
    const draft = new Draft(
      scene([
        box("g1", 0, 0, { groupIds: ["G"] }),
        box("g2", 150, 0, { groupIds: ["G"] }),
        box("in", 620, 640),
        { type: "frame", id: "f", x: 600, y: 600, width: 300, height: 200, children: ["in"] },
        arrow("e", "g1", "in"),
      ]),
    );
    const gap = el(draft, "g2").x - el(draft, "g1").x;
    const inOffset = [el(draft, "in").x - el(draft, "f").x, el(draft, "in").y - el(draft, "f").y];
    await autoLayoutDraft(draft, { direction: "down" });
    expect(el(draft, "g2").x - el(draft, "g1").x).toBeCloseTo(gap, 6);
    expect(el(draft, "in").x - el(draft, "f").x).toBeCloseTo(inOffset[0], 6);
    expect(el(draft, "in").y - el(draft, "f").y).toBeCloseTo(inOffset[1], 6);
    expect(el(draft, "f").y).toBeGreaterThan(el(draft, "g1").y + 60);
    expectBoundEnds(draft, "e");
  });

  it("refuses to lay out fewer than two nodes", async () => {
    const draft = new Draft(scene([box("a", 0, 0)]));
    await expect(autoLayoutDraft(draft)).rejects.toThrow(/at least two/);
  });
});

describe("autoLayoutCanvas (user action)", () => {
  function fakeApi(elements: El[], selected: string[] = []) {
    const api = new FakeApi(elements);
    for (const id of selected) api.selectedElementIds[id] = true;
    return Object.assign(api, { setToast: vi.fn() });
  }

  it("lays out the selection as one IMMEDIATELY undo step", async () => {
    const api = fakeApi(orgChart(), ["ceo", "cto", "cfo"]);
    const dev = api.byId("dev");
    expect(await autoLayoutCanvas(api as never, "tree")).toBe(true);
    expect(api.calls.map((c) => c.captureUpdate)).toEqual(["IMMEDIATELY"]);
    expect(api.byId("ceo").y).toBeLessThan(api.byId("cto").y);
    expect(api.byId("dev")).toMatchObject({ x: dev.x, y: dev.y });
  });

  it("toasts instead of failing when there is nothing to lay out", async () => {
    const api = fakeApi(scene([box("a", 0, 0)]));
    expect(await autoLayoutCanvas(api as never, "down")).toBe(false);
    expect(api.setToast).toHaveBeenCalledWith({ message: expect.stringMatching(/at least two/) });
    expect(api.calls).toHaveLength(0);
  });

  it("drops the result if the user edits while ELK is computing", async () => {
    const api = fakeApi(orgChart());
    setElkFactory(async () => {
      const elk = new ElkBundled();
      return {
        layout: async (g: never) => {
          api.externalEdit("dev", { backgroundColor: "#ffc9c9" });
          return elk.layout(g);
        },
      } as never;
    });
    try {
      expect(await autoLayoutCanvas(api as never, "down")).toBe(false);
    } finally {
      setElkFactory(async () => new ElkBundled());
    }
    expect(api.calls).toHaveLength(0);
    expect(api.setToast).toHaveBeenCalledWith({ message: expect.stringMatching(/changed/) });
  });

  it("matches only Alt/Option+Shift+L", () => {
    const k = (o: Partial<KeyboardEvent>) =>
      isAutoLayoutShortcut({ code: "KeyL", altKey: true, shiftKey: true, ...o } as KeyboardEvent);
    expect(k({})).toBe(true);
    expect(k({ shiftKey: false })).toBe(false);
    expect(k({ metaKey: true })).toBe(false);
    expect(k({ code: "KeyK" })).toBe(false);
  });
});
