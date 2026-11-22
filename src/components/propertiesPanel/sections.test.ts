import "../../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { containerPanelSection } from "../containers/containerPanelSection";
import { dataPanelSection } from "../shapeData/dataPanelSection";
import { stylePanelSection } from "../styles/stylePanelSection";
import type { StyleSectionView } from "../styles/stylesView";
import type { AnyPanelSection } from "./panel";
import { PANEL_SECTIONS } from "./sections";

// FR-65 / D-DX19: rare concepts show a row only when the selection uses them.
describe("strip progressive disclosure", () => {
  const style = (v: Partial<StyleSectionView>): StyleSectionView => ({
    styles: [{ id: "s1", name: "Primary" }],
    ids: ["a"],
    current: null,
    overrides: [],
    overrideIds: [],
    ...v,
  });

  it("shows Style only when a style is linked or overridden", () => {
    expect(stylePanelSection.inUse!(style({}))).toBe(false);
    expect(stylePanelSection.more!(style({}))).toMatchObject({ label: "Apply style" });
    expect(stylePanelSection.inUse!(style({ current: "s1" }))).toBe(true);
    expect(stylePanelSection.inUse!(style({ current: "mixed" }))).toBe(true);
    expect(stylePanelSection.inUse!(style({ overrides: ["strokeColor"] }))).toBe(true);
    // Instance children follow their master: a row only if it is styled, never "+".
    expect(stylePanelSection.inUse!(style({ master: { name: "Primary" } }))).toBe(true);
    expect(stylePanelSection.inUse!(style({ master: { name: null } }))).toBe(false);
    expect(stylePanelSection.more!(style({ master: { name: null } }))).toBeNull();
  });

  it("shows Data only when the selection has data", () => {
    const data = (rows: number, partial = 0, readOnly = false) => ({
      ids: ["a"],
      rows: Array.from({ length: rows }, (_, i) => ({ key: `k${i}`, value: "" })),
      partial,
      readOnly,
    });
    expect(dataPanelSection.inUse!(data(0) as never)).toBe(false);
    expect(dataPanelSection.more!(data(0) as never)).toMatchObject({ label: "Add data" });
    expect(dataPanelSection.inUse!(data(1) as never)).toBe(true);
    expect(dataPanelSection.inUse!(data(0, 2) as never)).toBe(true);
    expect(dataPanelSection.inUse!(data(0, 0, true) as never)).toBe(true);
  });

  it("turns 'make a stack' into a '+' action", () => {
    const make = { mode: "make" } as never;
    expect(containerPanelSection.title).toBe("Stack");
    expect(containerPanelSection.inUse!(make)).toBe(false);
    expect(containerPanelSection.more!(make)).toMatchObject({ label: "Make stack" });
    expect(containerPanelSection.more!(make)!.run).toBeTypeOf("function");
    const stack = { mode: "container" } as never;
    expect(containerPanelSection.inUse!(stack)).toBe(true);
    expect(containerPanelSection.more!(stack)).toBeNull();
  });

  it("has one Component row (Properties merged) and a Connection row", () => {
    const titles = PANEL_SECTIONS.map((s: AnyPanelSection) => s.title);
    expect(titles).toEqual(["Component", "Image", "Connection", "Stack", "Style", "Data"]);
  });
});
