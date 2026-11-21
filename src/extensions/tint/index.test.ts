import { describe, expect, it } from "vitest";
import { normalizeTintParams, tintPixels } from ".";

const px = (...rgba: number[]) => ({
  width: rgba.length / 4,
  height: 1,
  data: new Uint8ClampedArray(rgba),
});

describe("tint", () => {
  it("maps luma onto black → colour → white at full strength, keeping alpha", () => {
    const img = px(0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 90);
    tintPixels(img, { color: "#1971c2", strength: 100 });
    expect([...img.data.slice(0, 8)]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    // Mid gray lands (almost) on the tint colour.
    const mid = [...img.data.slice(8)];
    expect(mid[0]).toBeCloseTo(25, -1);
    expect(mid[1]).toBeCloseTo(113, -1);
    expect(mid[2]).toBeCloseTo(194, -1);
    expect(mid[3]).toBe(90);
  });

  it("mixes by strength", () => {
    const img = px(128, 128, 128, 255);
    tintPixels(img, { color: "#ff0000", strength: 50 });
    expect(img.data[0]).toBeGreaterThan(180);
    expect(img.data[1]).toBe(65);
  });

  it("validates params", () => {
    expect(normalizeTintParams({ color: "#F00" })).toEqual({ color: "#ff0000", strength: 50 });
    expect(() => normalizeTintParams({ color: "blue" })).toThrow(/tint: color/);
    expect(() => normalizeTintParams({ strength: -1 })).toThrow(/tint: strength/);
  });
});
