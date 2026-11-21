import "../../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { Draft } from "../../agent/scene/draft";
import { reflowDraft } from "./draftAccess";
import { DEFAULT_DEF, LAYOUT_NS, readDef, unitsOf, withDef, type ContainerDef } from "./model";
import { computeStack, type StackUnit } from "./stack";

type El = ExcalidrawElement;

let seq = 0;
function el(id: string, p: Partial<El> & Record<string, unknown> = {}): El {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    groupIds: [],
    boundElements: null,
    isDeleted: false,
    version: 1,
    versionNonce: ++seq,
    customData: undefined,
    ...p,
  } as unknown as El;
}

const def = (p: Partial<ContainerDef> = {}): ContainerDef => ({ ...DEFAULT_DEF, gi: 0, ...p });
const box = (id: string, groupIds: string[], d: ContainerDef, p: Partial<El> = {}) =>
  el(id, { groupIds, customData: withDef(el(id), d), ...p });
const u = (key: string, x: number, y: number, w: number, h: number, z = 0): StackUnit => ({
  key,
  rect: { x, y, w, h },
  z,
});
const pad = (n: number) => ({ top: n, right: n, bottom: n, left: n });

describe("computeStack", () => {
  const origin = { x: 100, y: 50, w: 0, h: 0 };

  it("stacks vertically in main-axis order and hugs both axes", () => {
    const r = computeStack(def({ gap: 10, padding: pad(5) }), origin, [
      u("b", 0, 300, 40, 20),
      u("a", 0, 0, 60, 30),
    ]);
    expect(r.order).toEqual(["a", "b"]);
    expect(r.at.get("a")).toEqual({ x: 105, y: 55 });
    expect(r.at.get("b")).toEqual({ x: 105, y: 95 });
    expect(r.box).toEqual({ x: 100, y: 50, w: 70, h: 70 });
  });

  it("stacks horizontally with cross-axis center / end alignment", () => {
    const d = def({ direction: "horizontal", gap: 0, padding: pad(0) });
    const units = [u("a", 0, 0, 10, 40), u("b", 50, 0, 10, 20)];
    expect(computeStack({ ...d, align: "center" }, origin, units).at.get("b")).toEqual({
      x: 110,
      y: 60,
    });
    expect(computeStack({ ...d, align: "end" }, origin, units).at.get("b")).toEqual({
      x: 110,
      y: 70,
    });
  });

  it("justifies along a fixed main axis and keeps the fixed size", () => {
    const d = def({ gap: 0, padding: pad(0), sizing: { w: "hug", h: "fixed" } });
    const b = { x: 0, y: 0, w: 0, h: 100 };
    const units = [u("a", 0, 0, 10, 10), u("b", 0, 50, 10, 10), u("c", 0, 90, 10, 10)];
    expect(computeStack({ ...d, justify: "center" }, b, units).at.get("a")!.y).toBe(35);
    expect(computeStack({ ...d, justify: "end" }, b, units).at.get("c")!.y).toBe(90);
    const sb = computeStack({ ...d, justify: "space-between" }, b, units);
    expect([...sb.at.values()].map((p) => p.y)).toEqual([0, 45, 90]);
    expect(sb.box).toEqual({ x: 0, y: 0, w: 10, h: 100 });
  });

  it("ties on the main-axis centre break by z-order; empty hugs the padding", () => {
    const r = computeStack(def(), origin, [u("top", 0, 0, 10, 10, 5), u("under", 0, 0, 10, 10, 1)]);
    expect(r.order).toEqual(["under", "top"]);
    expect(computeStack(def({ padding: pad(8) }), origin, []).box).toEqual({
      x: 100,
      y: 50,
      w: 16,
      h: 16,
    });
  });
});

describe("container model", () => {
  it("round-trips a definition and rejects bad or newer tags", () => {
    const b = box("B", ["G"], def({ gap: 4 }));
    expect(readDef(b)).toEqual(def({ gap: 4 }));
    expect(readDef(el("x", { customData: { [LAYOUT_NS]: { v: 2, container: def() } } }))).toBe(
      null,
    );
    expect(
      readDef(el("x", { customData: { [LAYOUT_NS]: { v: 1, container: def({ gap: -1 }) } } })),
    ).toBe(null);
    expect(withDef(b, null)[LAYOUT_NS]).toBeUndefined();
  });

  it("groups children into units: elements with their label, subgroups, minus bound arrows", () => {
    const members = [
      box("B", ["G"], def()),
      el("a", { groupIds: ["G"], boundElements: [{ id: "t", type: "text" }] }),
      el("t", { type: "text", groupIds: ["G"], containerId: "a" }),
      el("s1", { groupIds: ["S", "G"] }),
      el("s2", { groupIds: ["S", "G"] }),
      el("arr", {
        type: "arrow",
        groupIds: ["G"],
        startBinding: { elementId: "a" } as never,
        points: [],
      }),
      el("gone", { groupIds: ["G"], isDeleted: true }),
    ];
    expect(unitsOf(members, "G", "B").map((x) => [x.key, x.ids])).toEqual([
      ["a", ["a", "t"]],
      ["S", ["s1", "s2"]],
    ]);
  });
});

describe("reflowDraft", () => {
  it("re-flows a nested container first, then its parent, idempotently", () => {
    const d = new Draft([
      box("OUT", ["O"], def({ gap: 10, padding: pad(10) }), { x: 0, y: 0 }),
      el("a", { groupIds: ["O"], x: 500, y: 500, width: 50, height: 20 }),
      box("IN", ["I", "O"], def({ direction: "horizontal", gap: 5, padding: pad(0) }), {
        x: 0,
        y: 200,
      }),
      el("i1", { groupIds: ["I", "O"], x: 0, y: 0, width: 30, height: 30 }),
      el("i2", { groupIds: ["I", "O"], x: 100, y: 0, width: 30, height: 30 }),
    ]);
    reflowDraft(d, ["i1"]);
    const g = (id: string) => d.peek(id)!;
    expect([g("IN").width, g("IN").height]).toEqual([65, 30]);
    expect([g("IN").x, g("IN").y]).toEqual([10, 10]);
    expect([g("i1").x, g("i2").x, g("i2").y]).toEqual([10, 45, 10]);
    expect([g("a").x, g("a").y]).toEqual([10, 50]);
    expect([g("OUT").width, g("OUT").height]).toEqual([85, 80]);
    const versions = d.toArray().map((e) => e.version);
    reflowDraft(d, ["a", "i1", "OUT"]);
    expect(d.toArray().map((e) => e.version)).toEqual(versions);
  });

  it("ignores rotated, ungrouped and instance boxes", () => {
    const tagged = (p: Partial<El>) =>
      new Draft([
        box("B", ["G"], def(), { x: 0, y: 0, ...p }),
        el("a", { groupIds: ["G"], x: 300, y: 300 }),
      ]);
    expect(reflowDraft(tagged({ angle: 1 } as never), ["a"]).size).toBe(0);
    expect(reflowDraft(tagged({ groupIds: [] }), ["a"]).size).toBe(0);
    const inst = tagged({});
    inst.update("B", {
      customData: {
        ...inst.peek("B")!.customData,
        "excalidrawDesktop.component": { role: "instance" },
      },
    });
    expect(reflowDraft(inst, ["a"]).size).toBe(0);
  });
});
