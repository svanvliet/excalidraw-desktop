import { describe, expect, it } from "vitest";
import { grayscalePixels, normalizeGrayscaleParams } from ".";

const px = (...rgba: number[]) => ({
  width: rgba.length / 4,
  height: 1,
  data: new Uint8ClampedArray(rgba),
});

describe("grayscale", () => {
  it("fully desaturates to Rec. 709 luma, keeping alpha", () => {
    const img = px(224, 49, 49, 200);
    grayscalePixels(img, { amount: 100 });
    expect([...img.data]).toEqual([86, 86, 86, 200]);
  });

  it("mixes by amount; 0 leaves pixels alone", () => {
    const half = px(224, 49, 49, 255);
    grayscalePixels(half, { amount: 50 });
    expect([...half.data]).toEqual([155, 68, 68, 255]);
    const none = px(224, 49, 49, 255);
    grayscalePixels(none, { amount: 0 });
    expect([...none.data]).toEqual([224, 49, 49, 255]);
  });

  it("validates params", () => {
    expect(normalizeGrayscaleParams({})).toEqual({ amount: 100 });
    expect(() => normalizeGrayscaleParams({ amount: 101 })).toThrow(/grayscale: amount/);
    expect(() => normalizeGrayscaleParams({ level: 1 })).toThrow(/unknown param/);
  });
});
