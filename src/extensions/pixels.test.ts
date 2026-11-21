import { describe, expect, it } from "vitest";
import { blurPlane, boxRadius, compositeOver, hexToRgb, normalizeHex } from "./pixels";

describe("pixels", () => {
  it("normalizes hex colours", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#1971C2")).toBe("#1971c2");
    expect(normalizeHex("red")).toBeNull();
    expect(hexToRgb("#1971c2")).toEqual([25, 113, 194]);
  });

  it("blurs without losing mass and spreads exactly 3 × radius", () => {
    const w = 41;
    const plane = new Float32Array(w * w);
    plane[20 * w + 20] = 1;
    const r = boxRadius(6);
    expect(r).toBe(3);
    blurPlane(plane, w, w, r);
    const sum = plane.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(plane[20 * w + 20 + 3 * r]).toBeGreaterThan(0);
    expect(plane[20 * w + 20 + 3 * r + 1]).toBe(0);
    // Symmetric.
    expect(plane[20 * w + 18]).toBeCloseTo(plane[20 * w + 22]!, 6);
  });

  it("zero blur is a no-op", () => {
    expect(boxRadius(0)).toBe(0);
    const p = new Float32Array([0, 1, 0]);
    blurPlane(p, 3, 1, 0);
    expect([...p]).toEqual([0, 1, 0]);
  });

  it("composites source-over onto transparent and opaque pixels", () => {
    const out = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]),
    };
    compositeOver(out, [0, 0, 255], new Float32Array([0.5, 0.5]));
    expect([...out.data]).toEqual([0, 0, 255, 128, 128, 128, 255, 255]);
  });
});
