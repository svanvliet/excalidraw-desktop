import "../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { Draft, ToolError, type El } from "../agent/scene/draft";
import { LAYER_KEY, applyLayerEdit, buildLayerTree, findLayer, flattenLayers } from "./layers";

function scene(skeletons: Array<Record<string, unknown>>): El[] {
  return convertToExcalidrawElements(skeletons as unknown as ExcalidrawElementSkeleton[], {
    regenerateIds: false,
  });
}

function withGroups(els: El[], groups: Record<string, string[]>): El[] {
  return els.map((e) => (groups[e.id] ? newElementWith(e, { groupIds: groups[e.id] }) : e));
}

function fixture(): El[] {
  const base = scene([
    { type: "frame", id: "f", x: 0, y: 0, width: 500, height: 400, name: "Hero", children: ["in"] },
    { type: "rectangle", id: "in", x: 10, y: 10, width: 50, height: 50 },
    { type: "rectangle", id: "a", x: 600, y: 0, width: 100, height: 60, label: { text: "Alpha" } },
    { type: "ellipse", id: "b", x: 800, y: 0, width: 100, height: 60 },
    { type: "diamond", id: "c", x: 600, y: 300, width: 80, height: 80 },
    { type: "text", id: "t", x: 900, y: 300, text: "Note" },
  ]);
  // b and c share inner group g1, nested in outer g2 with a.
  return withGroups(base, { a: ["g2"], b: ["g1", "g2"], c: ["g1", "g2"] });
}

describe("buildLayerTree", () => {
  it("lists frames first, then groups nested innermost-inside-outermost, topmost first", () => {
    const tree = buildLayerTree(fixture());
    expect(tree.map((n) => [n.kind, n.id])).toEqual([
      ["frame", "f"],
      ["element", "t"],
      ["group", "g2"],
    ]);
    const frame = tree[0];
    expect(frame.label).toBe("Hero");
    expect(frame.children.map((n) => n.id)).toEqual(["in"]);
    const g2 = tree[2];
    expect(g2.children.map((n) => n.id)).toEqual(["g1", "a"]);
    expect(findLayer(tree, "g1")!.children.map((n) => n.id)).toEqual(["c", "b"]);
    expect(g2.elementIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("folds bound text into its container's label and skips deleted elements", () => {
    const els = fixture().map((e) => (e.id === "t" ? newElementWith(e, { isDeleted: true }) : e));
    const rows = flattenLayers(buildLayerTree(els));
    expect(rows.find((r) => r.id === "a")!.label).toBe("Alpha");
    expect(rows.some((r) => r.id === "t")).toBe(false);
    expect(rows.filter((r) => r.type === "text")).toEqual([]);
    expect(rows.find((r) => r.id === "b")!).toMatchObject({ label: "Ellipse", depth: 2 });
  });
});

describe("applyLayerEdit", () => {
  it("renames an element into the prefixed customData key and clears it again", () => {
    const draft = new Draft(fixture());
    expect(applyLayerEdit(draft, "b", { name: "  Logo  " })).toBe("element");
    expect(draft.get("b")!.customData).toEqual({ [LAYER_KEY]: { v: 1, name: "Logo" } });
    expect(findLayer(buildLayerTree(draft.toArray()), "b")!.label).toBe("Logo");
    applyLayerEdit(draft, "b", { name: "" });
    expect(draft.get("b")!.customData).toEqual({});
  });

  it("names a group on every member and locks all members", () => {
    const draft = new Draft(fixture());
    expect(applyLayerEdit(draft, "g1", { name: "Pair", locked: true })).toBe("group");
    for (const id of ["b", "c"]) {
      expect(draft.get(id)!.customData![LAYER_KEY]).toEqual({ v: 1, groups: { g1: "Pair" } });
      expect(draft.get(id)!.locked).toBe(true);
    }
    const tree = buildLayerTree(draft.toArray());
    expect(findLayer(tree, "g1")).toMatchObject({ label: "Pair", locked: true });
    expect(findLayer(tree, "g2")!.locked).toBe(false);
  });

  it("renames frames natively and locks a container with its bound text", () => {
    const draft = new Draft(fixture());
    expect(applyLayerEdit(draft, "f", { name: "Intro" })).toBe("frame");
    expect((draft.get("f") as El & { name: string }).name).toBe("Intro");
    expect(draft.get("f")!.customData?.[LAYER_KEY]).toBeUndefined();
    applyLayerEdit(draft, "a", { locked: true });
    const label = draft.live().find((e) => e.type === "text" && e.id !== "t")!;
    expect(label.locked).toBe(true);
  });

  it("rejects unknown ids", () => {
    expect(() => applyLayerEdit(new Draft(fixture()), "nope", { locked: true })).toThrow(ToolError);
  });
});
