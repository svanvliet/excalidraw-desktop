import "../../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { Draft } from "../../agent/scene/draft";
import {
  addToContainer,
  describeContainers,
  makeContainer,
  moveChild,
  removeContainer,
  removeFromContainer,
  updateContainer,
} from "./actions";
import { COMPONENT_NS, readDef } from "./model";

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
    frameId: null,
    version: 1,
    versionNonce: ++seq,
    customData: undefined,
    ...p,
  } as unknown as El;
}

const pos = (d: Draft, id: string) => {
  const e = d.get(id)!;
  return [e.x, e.y];
};

describe("container actions", () => {
  it("makes a hugging vertical stack with the box under the children", () => {
    const d = new Draft([
      el("a", { x: 100, y: 300, width: 40, height: 20 }),
      el("b", { x: 120, y: 100, width: 60, height: 30 }),
      el("z", { x: 500, y: 500 }),
    ]);
    const made = makeContainer(d, ["a", "b"], { gap: 10, padding: 5 });
    const box = d.get(made.containerId)!;
    expect(readDef(box)).toMatchObject({ direction: "vertical", gap: 10, gi: 0 });
    // b is higher, so it comes first; the anchor is the box's top-left.
    expect(pos(d, "b")).toEqual([box.x + 5, box.y + 5]);
    expect(pos(d, "a")).toEqual([box.x + 5, box.y + 5 + 30 + 10]);
    expect([box.width, box.height]).toEqual([5 + 60 + 5, 5 + 30 + 10 + 20 + 5]);
    expect(d.get("a")!.groupIds).toEqual([made.groupId]);
    expect(box.groupIds).toEqual([made.groupId]);
    expect(d.toArray().map((e) => e.id)[0]).toBe(made.containerId);
    expect(describeContainers(d)[0].children).toEqual([
      { key: "b", ids: ["b"] },
      { key: "a", ids: ["a"] },
    ]);
  });

  it("keeps a whole user group as one unit and nests containers", () => {
    const d = new Draft([
      el("a", { x: 0, y: 0, groupIds: ["g"] }),
      el("b", { x: 20, y: 0, groupIds: ["g"] }),
      el("c", { x: 0, y: 50 }),
    ]);
    const inner = makeContainer(d, ["a", "b"], { direction: "horizontal", gap: 0, padding: 0 });
    expect(d.get("a")!.groupIds).toEqual(["g", inner.groupId]);
    const outer = makeContainer(d, [inner.containerId, "a", "b", "c"], { gap: 0, padding: 0 });
    expect(d.get(inner.containerId)!.groupIds).toEqual([inner.groupId, outer.groupId]);
    expect(readDef(d.get(inner.containerId)!)!.gi).toBe(0);
    const list = describeContainers(d);
    expect(list.find((c) => c.containerId === inner.containerId)!.parentContainerId).toBe(
      outer.containerId,
    );
    // The pair is one unit (gap has no effect); padding grows both boxes via draft reflow.
    updateContainer(d, inner.containerId, { gap: 10 });
    expect(d.get(inner.containerId)!.width).toBe(30);
    updateContainer(d, inner.containerId, { padding: 5 });
    expect(d.get(inner.containerId)!.width).toBe(40);
    expect(d.get(outer.containerId)!.width).toBe(40);
  });

  it("refuses part of a component instance and bumps a master's tag index", () => {
    const inst = (id: string, x: number) =>
      el(id, {
        x,
        groupIds: ["ig"],
        customData: {
          [COMPONENT_NS]: { v: 1, role: "instance", componentId: "k", slot: id, gi: 0 },
        },
      });
    const d = new Draft([
      inst("i1", 0),
      inst("i2", 20),
      ...["m1", "m2"].map((id) =>
        el(id, {
          y: 100,
          groupIds: ["mg"],
          customData: {
            [COMPONENT_NS]: { v: 1, role: "master", componentId: "k", slot: id, gi: 0 },
          },
        }),
      ),
    ]);
    expect(() => makeContainer(d, ["i1"])).toThrow(/whole instance/);
    makeContainer(d, ["i1", "i2"]);
    const made = makeContainer(d, ["m1"]);
    const m1 = d.get("m1")!;
    expect(m1.groupIds).toEqual([made.groupId, "mg"]);
    expect((m1.customData as Record<string, { gi: number }>)[COMPONENT_NS].gi).toBe(1);
    expect(d.get(made.containerId)!.groupIds).toEqual([made.groupId, "mg"]);
  });

  it("switching direction keeps the order; order and moveChild reorder", () => {
    const d = new Draft([
      el("a", { y: 0 }),
      el("b", { y: 100, x: -50 }),
      el("c", { y: 200, x: -100 }),
    ]);
    const { containerId } = makeContainer(d, ["a", "b", "c"], { gap: 0, padding: 0 });
    updateContainer(d, containerId, { direction: "horizontal" });
    expect(["a", "b", "c"].map((id) => d.get(id)!.x)).toEqual([
      d.get(containerId)!.x,
      d.get(containerId)!.x + 10,
      d.get(containerId)!.x + 20,
    ]);
    updateContainer(d, containerId, { order: ["c", "a", "b"] });
    expect(describeContainers(d)[0].children).toEqual([
      { key: "c", ids: ["c"] },
      { key: "a", ids: ["a"] },
      { key: "b", ids: ["b"] },
    ]);
    moveChild(d, "b", 0);
    expect((describeContainers(d)[0].children as { key: string }[]).map((u) => u.key)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(() => updateContainer(d, containerId, { order: ["a"] })).toThrow(/every child/);
    expect(() => updateContainer(d, containerId, { gap: -1 })).toThrow(/gap/);
  });

  it("fixed size with justify and align", () => {
    const d = new Draft([el("a", { width: 10, height: 10 }), el("b", { y: 50, width: 20 })]);
    const { containerId } = makeContainer(d, ["a", "b"], {
      padding: 0,
      gap: 0,
      height: 100,
      width: 40,
      justify: "space-between",
      align: "center",
    });
    const box = d.get(containerId)!;
    expect([box.width, box.height]).toEqual([40, 100]);
    expect(pos(d, "a")).toEqual([box.x + 15, box.y]);
    expect(pos(d, "b")).toEqual([box.x + 10, box.y + 90]);
  });

  it("removes a container (dissolving its group) or just its tag", () => {
    const d = new Draft([el("a"), el("b", { y: 30 })]);
    const one = makeContainer(d, ["a", "b"]);
    removeContainer(d, one.containerId, { keepBox: true });
    expect(readDef(d.get(one.containerId)!)).toBeNull();
    expect(d.get("a")!.groupIds).toEqual([one.groupId]);
    const d2 = new Draft([el("a"), el("b", { y: 30 })]);
    const two = makeContainer(d2, ["a", "b"]);
    removeContainer(d2, "a");
    expect(d2.get(two.containerId)).toBeUndefined();
    expect(d2.get("a")!.groupIds).toEqual([]);
  });

  it("adds at an index, takes out of another container, and removes back out", () => {
    const d = new Draft([
      el("a", { y: 0 }),
      el("b", { y: 30 }),
      el("x", { x: 300, y: 0 }),
      el("y", { x: 300, y: 40 }),
    ]);
    const one = makeContainer(d, ["a", "b"], { gap: 0, padding: 0 });
    const two = makeContainer(d, ["x", "y"], { gap: 0, padding: 0 });
    addToContainer(d, one.containerId, ["x"], 1);
    expect(
      (
        describeContainers(d).find((c) => c.containerId === one.containerId)!.children as {
          key: string;
        }[]
      ).map((u) => u.key),
    ).toEqual(["a", "x", "b"]);
    expect(d.get("x")!.groupIds).toEqual([one.groupId]);
    expect(d.get(two.containerId)!.height).toBe(10);
    expect(d.get(one.containerId)!.height).toBe(30);

    removeFromContainer(d, ["x"]);
    expect(d.get("x")!.groupIds).toEqual([]);
    const box = d.get(one.containerId)!;
    expect(box.height).toBe(20);
    expect(d.get("x")!.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(() => removeFromContainer(d, ["x"])).toThrow(/direct child/);
    expect(() => addToContainer(d, one.containerId, [one.containerId])).toThrow();
  });

  it("drags bound arrows along with moved children", () => {
    const d = new Draft([
      el("a", { x: 0, y: 200, boundElements: [{ id: "ar", type: "arrow" }] }),
      el("b", { x: 0, y: 0 }),
      el("t", { x: 300, y: 200, boundElements: [{ id: "ar", type: "arrow" }] }),
      el("ar", {
        type: "arrow",
        x: 10,
        y: 205,
        width: 290,
        height: 0,
        points: [
          [0, 0],
          [290, 0],
        ],
        startBinding: { elementId: "a", focus: 0, gap: 0 },
        endBinding: { elementId: "t", focus: 0, gap: 0 },
      }),
    ]);
    makeContainer(d, ["a", "b"], { gap: 0, padding: 0 });
    const a = d.get("a")!;
    const ar = d.get("ar")! as unknown as { x: number; y: number };
    expect(a.y).toBe(10);
    expect(ar.y).toBeLessThan(200);
  });
});
