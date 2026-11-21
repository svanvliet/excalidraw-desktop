import { describe, expect, it, vi } from "vitest";
import {
  applyFilterToPixels,
  installCanvasFilterPolyfill,
  parseFilter,
} from "./canvasFilterPolyfill";

const IMAGE_INVERT_FILTER = "invert(100%) hue-rotate(180deg) saturate(1.25)";
const THEME_FILTER = "invert(93%) hue-rotate(180deg)";

const px = (r: number, g: number, b: number) => new Uint8ClampedArray([r, g, b, 255]);

describe("parseFilter", () => {
  it("parses Excalidraw's image filter", () => {
    expect(parseFilter(IMAGE_INVERT_FILTER)).toEqual([
      { kind: "invert", amount: 1 },
      { kind: "hue-rotate", degrees: 180 },
      { kind: "saturate", amount: 1.25 },
    ]);
  });

  it("returns null for none and unsupported functions", () => {
    expect(parseFilter("none")).toBeNull();
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("blur(2px)")).toBeNull();
    expect(parseFilter("invert(100%) url(#x)")).toBeNull();
  });
});

describe("applyFilterToPixels", () => {
  it("cancels the dark-theme canvas filter for photos", () => {
    // Image pre-filter followed by the canvas-level theme filter should land
    // near the original color, which is what Excalidraw relies on.
    for (const [r, g, b] of [
      [200, 60, 40],
      [30, 120, 220],
      [128, 128, 128],
      [240, 220, 180],
    ]) {
      const data = px(r, g, b);
      applyFilterToPixels(data, parseFilter(IMAGE_INVERT_FILTER)!);
      applyFilterToPixels(data, parseFilter(THEME_FILTER)!);
      expect(Math.abs(data[0] - r)).toBeLessThan(40);
      expect(Math.abs(data[1] - g)).toBeLessThan(40);
      expect(Math.abs(data[2] - b)).toBeLessThan(40);
      expect(data[3]).toBe(255);
    }
  });

  it("inverts with invert(100%)", () => {
    const data = px(10, 100, 250);
    applyFilterToPixels(data, [{ kind: "invert", amount: 1 }]);
    expect(Array.from(data)).toEqual([245, 155, 5, 255]);
  });
});

function fakeProto() {
  const calls: unknown[][] = [];
  const proto = {
    save: vi.fn(),
    restore: vi.fn(),
    drawImage(...args: unknown[]) {
      calls.push(args);
    },
  } as unknown as CanvasRenderingContext2D;
  return { proto, calls };
}

describe("installCanvasFilterPolyfill", () => {
  it("does nothing when filter is native", () => {
    const { proto } = fakeProto();
    Object.defineProperty(proto, "filter", { value: "none", writable: true });
    expect(installCanvasFilterPolyfill(proto)).toBe(false);
  });

  it("tracks filter through save/restore and filters drawImage sources", () => {
    const { proto, calls } = fakeProto();
    const scratch = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data: px(10, 20, 30) }),
        putImageData: vi.fn(),
      }),
    } as unknown as HTMLCanvasElement;
    expect(installCanvasFilterPolyfill(proto, { createCanvas: () => scratch })).toBe(true);
    const ctx = Object.create(proto) as CanvasRenderingContext2D;
    expect(ctx.filter).toBe("none");

    const source = { width: 4, height: 4 } as unknown as CanvasImageSource;
    ctx.save();
    ctx.filter = IMAGE_INVERT_FILTER;
    ctx.drawImage(source, 0, 0, 4, 4);
    ctx.restore();
    expect(ctx.filter).toBe("none");
    ctx.drawImage(source, 1, 1);

    expect(calls[0][0]).toBe(scratch);
    expect(calls[0].slice(1)).toEqual([0, 0, 4, 4]);
    expect(calls[1][0]).toBe(source);
  });
});
