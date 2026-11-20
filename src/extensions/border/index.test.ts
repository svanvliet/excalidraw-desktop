import { describe, expect, it } from "vitest";
import { basePlan } from "../pipeline";
import { recordingContext } from "../testRaster";
import { maskStep } from "../mask/geometry";
import { borderExtension, normalizeBorderParams } from "./index";

describe("normalizeBorderParams", () => {
  it("fills defaults and normalizes colours", () => {
    expect(normalizeBorderParams({})).toEqual({ width: 4, color: "#868e96", opacity: 100 });
    expect(normalizeBorderParams({ width: 0.5, color: "#ABC", opacity: 0 })).toEqual({
      width: 0.5,
      color: "#aabbcc",
      opacity: 0,
    });
  });

  it.each([
    null,
    [],
    { width: 0 },
    { width: 101 },
    { color: "red" },
    { color: "#12345" },
    { opacity: 101 },
    { glow: 1 },
  ])("rejects %j", (input) => expect(() => normalizeBorderParams(input)).toThrow(/border:/));
});

describe("border render", () => {
  const base = basePlan({
    element: { x: 0, y: 0, width: 100, height: 50 },
    crop: null,
    naturalWidth: 300,
    naturalHeight: 150,
  });

  it("sizes the stroke in scene units and never past the centre", () => {
    const ops: string[] = [];
    borderExtension.render!(recordingContext(ops), base, {
      width: 100,
      color: "#000000",
      opacity: 50,
    });
    expect(ops).toContain("globalAlpha=0.5");
    // min(100 units × 3 px/unit, 150 / 2) = 75px inside → lineWidth 150.
    expect(ops).toContain("lineWidth=150");
  });

  it("traces a rounded mask outline and skips fully transparent borders", () => {
    const plan = maskStep(base, { shape: "roundedRect", radius: 20 });
    const ops: string[] = [];
    borderExtension.render!(recordingContext(ops), plan, {
      width: 2,
      color: "#000000",
      opacity: 100,
    });
    expect(ops.filter((o) => o.startsWith("arcTo"))).toHaveLength(4);
    const none: string[] = [];
    borderExtension.render!(recordingContext(none), plan, {
      width: 2,
      color: "#000000",
      opacity: 0,
    });
    expect(none).toEqual([]);
  });
});
