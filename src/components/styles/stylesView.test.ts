import "../../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { El } from "../../agent/scene/draft";
import { COMPONENT_NS } from "../../extensions/components/model";
import { STYLE_NS, type StyleTag } from "../../extensions/styles/model";
import { styleSectionView } from "./stylesView";

const tag = (id: string, overrides?: StyleTag["overrides"]): StyleTag => ({
  v: 1,
  id,
  name: id.toUpperCase(),
  rev: 1,
  props: { strokeColor: "#111111" },
  ...(overrides ? { overrides } : {}),
});
const withData = (el: El, data: Record<string, unknown>): El => ({
  ...el,
  customData: { ...el.customData, ...data },
});

const base = convertToExcalidrawElements(
  [
    { type: "rectangle", id: "a", x: 0, y: 0, width: 10, height: 10 },
    { type: "rectangle", id: "b", x: 20, y: 0, width: 10, height: 10 },
    { type: "rectangle", id: "c", x: 40, y: 0, width: 10, height: 10 },
    { type: "rectangle", id: "box", x: 60, y: 0, width: 40, height: 20, label: { text: "hi" } },
  ] as ExcalidrawElementSkeleton[],
  { regenerateIds: false },
) as El[];
const get = (id: string) => base.find((e) => e.id === id)!;
const a = withData(get("a"), { [STYLE_NS]: tag("s1") });
const b = withData(get("b"), { [STYLE_NS]: tag("s1", { strokeColor: "#ff0000" }) });
const c = withData(get("c"), { [STYLE_NS]: tag("s2") });
const box = get("box");
const label = base.find((e) => e.type === "text")!;
const all = [a, b, c, box, label];

describe("styleSectionView", () => {
  it("hides with nothing stylable selected", () => {
    expect(styleSectionView([], all)).toBeNull();
  });

  it("reports the linked style, mixed selections and overrides", () => {
    const one = styleSectionView([a], all)!;
    expect(one.current).toBe("s1");
    expect(one.styles.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(one.overrides).toEqual([]);

    const pair = styleSectionView([a, b], all)!;
    expect(pair.current).toBe("s1");
    expect(pair.overrides).toEqual(["strokeColor"]);
    expect(pair.overrideIds).toEqual(["b"]);

    expect(styleSectionView([a, c], all)!.current).toBe("mixed");
    expect(styleSectionView([box], all)!.current).toBeNull();
  });

  it("drops the label of a selected container", () => {
    expect(styleSectionView([box, label], all)!.ids).toEqual(["box"]);
    expect(styleSectionView([label], all)!.ids).toEqual([label.id]);
  });

  it("shows instance children as following their master", () => {
    const child = withData(get("b"), {
      [COMPONENT_NS]: { v: 1, role: "instance", componentId: "k", slot: "a", gi: 0 },
    });
    const view = styleSectionView([child], [...all, child])!;
    expect(view.ids).toEqual([]);
    expect(view.master).toEqual({ name: "S1" });
  });
});
