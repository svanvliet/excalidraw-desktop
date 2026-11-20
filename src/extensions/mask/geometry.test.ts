import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_PX,
  maskFileId,
  normalizeMaskParams,
  planMask,
  restoreBounds,
  visibleSourceRect,
} from "./geometry";

const box = { x: 10, y: 20, width: 200, height: 100 };

describe("normalizeMaskParams", () => {
  it("accepts circle and fills the roundedRect default radius", () => {
    expect(normalizeMaskParams({ shape: "circle" })).toEqual({ shape: "circle" });
    expect(normalizeMaskParams({ shape: "roundedRect" })).toEqual({
      shape: "roundedRect",
      radius: 15,
    });
    expect(normalizeMaskParams({ shape: "roundedRect", radius: 0 }).radius).toBe(0);
  });

  it.each([
    null,
    "circle",
    [],
    {},
    { shape: "star" },
    { shape: "roundedRect", radius: 51 },
    { shape: "roundedRect", radius: -1 },
    { shape: "roundedRect", radius: "10" },
    { shape: "roundedRect", radius: NaN },
    { shape: "circle", radius: 10 },
    { shape: "circle", extra: 1 },
  ])("rejects %j", (input) => {
    expect(() => normalizeMaskParams(input)).toThrow(/mask:/);
  });
});

describe("visibleSourceRect", () => {
  it("is the whole image without crop", () => {
    expect(visibleSourceRect(null, 400, 300)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it("rescales crop when the decoded size differs from crop.natural*", () => {
    const crop = { x: 10, y: 20, width: 100, height: 50, naturalWidth: 200, naturalHeight: 100 };
    expect(visibleSourceRect(crop, 400, 200)).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });
});

describe("planMask circle", () => {
  it("takes a centred square of the visible image and keeps the element centre", () => {
    const plan = planMask({
      params: { shape: "circle" },
      element: box,
      crop: null,
      naturalWidth: 400,
      naturalHeight: 200,
    });
    expect(plan.element).toEqual({ x: 60, y: 20, width: 100, height: 100 });
    expect(plan.sourceRect).toEqual({ x: 100, y: 0, width: 200, height: 200 });
    expect(plan.outWidth).toBe(200);
    expect(plan.outHeight).toBe(200);
    expect(plan.cornerRadiusPx).toBe(100);
  });

  it("selects within the crop region", () => {
    const plan = planMask({
      params: { shape: "circle" },
      element: box,
      crop: { x: 100, y: 50, width: 400, height: 200, naturalWidth: 1000, naturalHeight: 800 },
      naturalWidth: 1000,
      naturalHeight: 800,
    });
    expect(plan.sourceRect).toEqual({ x: 200, y: 50, width: 200, height: 200 });
  });

  it("caps output at MAX_OUTPUT_PX and uses square pixels for stretched images", () => {
    const plan = planMask({
      params: { shape: "circle" },
      element: { x: 0, y: 0, width: 100, height: 100 },
      crop: null,
      naturalWidth: 4000,
      naturalHeight: 2000,
    });
    expect(plan.sourceRect).toEqual({ x: 0, y: 0, width: 4000, height: 2000 });
    expect(plan.outWidth).toBe(MAX_OUTPUT_PX);
    expect(plan.outHeight).toBe(MAX_OUTPUT_PX);
  });

  it("upsamples vector sources and falls back when SVG has no intrinsic size", () => {
    const plan = planMask({
      params: { shape: "circle" },
      element: box,
      crop: null,
      naturalWidth: 0,
      naturalHeight: 0,
      isVector: true,
    });
    expect(plan.sourceRect).toEqual({ x: 50, y: 0, width: 100, height: 100 });
    expect(plan.outWidth).toBe(200);
  });
});

describe("planMask roundedRect", () => {
  it("keeps bounds and aspect, converts radius % to output px", () => {
    const plan = planMask({
      params: { shape: "roundedRect", radius: 20 },
      element: box,
      crop: null,
      naturalWidth: 400,
      naturalHeight: 200,
    });
    expect(plan.element).toEqual(box);
    expect(plan.sourceRect).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect([plan.outWidth, plan.outHeight]).toEqual([400, 200]);
    expect(plan.cornerRadiusPx).toBe(40);
  });

  it("caps the longest side", () => {
    const plan = planMask({
      params: { shape: "roundedRect", radius: 50 },
      element: box,
      crop: null,
      naturalWidth: 4000,
      naturalHeight: 2000,
    });
    expect([plan.outWidth, plan.outHeight]).toEqual([1024, 512]);
    expect(plan.cornerRadiusPx).toBe(256);
  });

  it("rejects zero-size elements", () => {
    expect(() =>
      planMask({
        params: { shape: "circle" },
        element: { x: 0, y: 0, width: 0, height: 10 },
        crop: null,
        naturalWidth: 10,
        naturalHeight: 10,
      }),
    ).toThrow(/no size/);
  });
});

describe("restoreBounds", () => {
  it("round-trips when the masked element was not edited", () => {
    const b = restoreBounds(
      { x: 60, y: 20, width: 100, height: 100 },
      { width: 100, height: 100 },
      { width: 200, height: 100 },
    );
    expect(b).toEqual(box);
  });

  it("follows moves and resizes", () => {
    const b = restoreBounds(
      { x: 0, y: 0, width: 200, height: 200 },
      { width: 100, height: 100 },
      { width: 200, height: 100 },
    );
    expect(b).toEqual({ x: -100, y: 0, width: 400, height: 200 });
  });
});

describe("maskFileId", () => {
  const plan = (radius: number) =>
    planMask({
      params: { shape: "roundedRect", radius },
      element: box,
      crop: null,
      naturalWidth: 400,
      naturalHeight: 200,
    });

  it("is deterministic and Excalidraw-id shaped", () => {
    const a = maskFileId("abc", plan(10), 1);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(maskFileId("abc", plan(10), 1)).toBe(a);
  });

  it("changes with source, params and version", () => {
    const a = maskFileId("abc", plan(10), 1);
    expect(maskFileId("abd", plan(10), 1)).not.toBe(a);
    expect(maskFileId("abc", plan(11), 1)).not.toBe(a);
    expect(maskFileId("abc", plan(10), 2)).not.toBe(a);
  });
});
