import "../../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { convertToExcalidrawElements, FONT_FAMILY } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { applies, normaliseProps, StyleError, winnerDef, type StyleTag } from "./model";

const els = convertToExcalidrawElements(
  [
    { type: "rectangle", id: "r", x: 0, y: 0, width: 10, height: 10 },
    { type: "text", id: "t", x: 0, y: 0, text: "a" },
    { type: "arrow", id: "a", x: 0, y: 0, width: 10, height: 0, elbowed: true },
    { type: "frame", id: "f", x: 0, y: 0, width: 10, height: 10, children: [] },
  ] as ExcalidrawElementSkeleton[],
  { regenerateIds: false },
);
const byId = (id: string) => els.find((e) => e.id === id)!;

describe("styles model", () => {
  it("applies each key only where it means something", () => {
    expect(applies(byId("r"), "roundness")).toBe(true);
    expect(applies(byId("r"), "fontSize")).toBe(false);
    expect(applies(byId("t"), "textColor")).toBe(true);
    expect(applies(byId("t"), "strokeColor")).toBe(false);
    expect(applies(byId("a"), "roundness")).toBe(false); // elbow arrows
    expect(applies(byId("f"), "opacity")).toBe(false);
  });

  it("validates and normalises props", () => {
    expect(normaliseProps({ fontFamily: "Nunito", roughness: 1.4 })).toEqual({
      fontFamily: FONT_FAMILY.Nunito,
      roughness: 1,
    });
    expect(normaliseProps({ strokeColor: null }, true)).toEqual({ strokeColor: null });
    expect(() => normaliseProps({ fillStyle: "dots" })).toThrow(StyleError);
    expect(() => normaliseProps({ colour: "#000" })).toThrow(/Unknown style property/);
    expect(() => normaliseProps({ opacity: 120 })).toThrow(StyleError);
  });

  it("picks the same winning definition regardless of order", () => {
    const t = (rev: number, color: string): StyleTag => ({
      v: 1,
      id: "s",
      name: "S",
      rev,
      props: { strokeColor: color },
    });
    const tags = [t(2, "#111"), t(3, "#222"), t(3, "#333")];
    expect(winnerDef(tags)).toEqual(winnerDef([...tags].reverse()));
    expect(winnerDef(tags)!.rev).toBe(3);
  });
});
