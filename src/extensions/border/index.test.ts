import { describe, expect, it } from "vitest";
import { basePlan } from "../pipeline";
import { recordingContext } from "../testRaster";
import { maskStep } from "../mask/geometry";
import {
  borderExtension,
  migrateBorderParams,
  normalizeBorderParams,
  type BorderParams,
} from "./index";

const crisp = { style: "solid", roughness: 0 } as const;

describe("normalizeBorderParams", () => {
  it("fills defaults and normalizes colours", () => {
    expect(normalizeBorderParams({})).toEqual({
      width: 2,
      color: "#868e96",
      opacity: 100,
      ...crisp,
    });
    expect(
      normalizeBorderParams({
        width: 0.5,
        color: "#ABC",
        opacity: 0,
        style: "dotted",
        roughness: 2,
      }),
    ).toEqual({ width: 0.5, color: "#aabbcc", opacity: 0, style: "dotted", roughness: 2 });
  });

  it.each([
    null,
    [],
    { width: 0 },
    { width: 101 },
    { color: "red" },
    { color: "#12345" },
    { opacity: 101 },
    { style: "wavy" },
    { roughness: 0.5 },
    { glow: 1 },
  ])("rejects %j", (input) => expect(() => normalizeBorderParams(input)).toThrow(/border:/));
});

describe("migrateBorderParams", () => {
  it("keeps v1 borders crisp and solid", () => {
    const v1 = { width: 8, color: "#1971c2", opacity: 100 };
    expect(normalizeBorderParams(migrateBorderParams(v1, 1))).toEqual({ ...v1, ...crisp });
    expect(migrateBorderParams({ roughness: 1 }, 2)).toEqual({ roughness: 1 });
  });
});

describe("border render", () => {
  const base = basePlan({
    element: { x: 0, y: 0, width: 100, height: 50 },
    crop: null,
    naturalWidth: 300,
    naturalHeight: 150,
  });
  const params = (p: Partial<BorderParams>): BorderParams => ({
    width: 2,
    color: "#000000",
    opacity: 100,
    ...crisp,
    ...p,
  });
  const draw = (plan: typeof base, p: Partial<BorderParams>) => {
    const ops: string[] = [];
    borderExtension.render!(recordingContext(ops), plan, params(p));
    return ops;
  };

  it("sizes the stroke in scene units and never past the centre", () => {
    const ops = draw(base, { width: 100, opacity: 50 });
    expect(ops).toContain("globalAlpha=0.5");
    // min(100 units × 3 px/unit, 150 / 2) = 75px inside → lineWidth 150.
    expect(ops).toContain("lineWidth=150");
  });

  it("traces a rounded mask outline and skips fully transparent borders", () => {
    const plan = maskStep(base, { shape: "roundedRect", radius: 20 });
    expect(draw(plan, {}).filter((o) => o.startsWith("arcTo"))).toHaveLength(4);
    expect(draw(plan, { opacity: 0 })).toEqual([]);
  });

  it("draws dashes like Excalidraw, in scene units along the mask", () => {
    const circle = maskStep(base, { shape: "circle" });
    const ops = draw(circle, { style: "dashed", width: 4 });
    expect(ops).toContain("scale(3,3)");
    expect(ops).toContain("setLineDash(8,12)");
    expect(ops).toContain("lineWidth=4.5");
    // One stroke (multi-stroke is off for dashes), made of curves.
    expect(ops.filter((o) => o === "stroke()")).toHaveLength(1);
    expect(ops.some((o) => o.startsWith("bezierCurveTo"))).toBe(true);
    expect(draw(circle, { style: "dotted", width: 1 })).toContain("setLineDash(1.5,7)");
  });

  it("renders sloppy strokes deterministically, varying with the params", () => {
    const sloppy = draw(base, { roughness: 2 });
    expect(sloppy.some((o) => o.startsWith("bezierCurveTo"))).toBe(true);
    expect(draw(base, { roughness: 2 })).toEqual(sloppy);
    expect(draw(base, { roughness: 1 })).not.toEqual(sloppy);
    expect(sloppy.some((o) => o.startsWith("setLineDash"))).toBe(false);
  });
});
