import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { normalizeShadowParams, planShadow, renderShadow, shadowExtension } from ".";
import { borderExtension } from "../border";
import { grayscaleExtension } from "../grayscale";
import { maskExtension } from "../mask";
import { basePlan, type ImagePlan } from "../pipeline";
import { readStack, runChain, type ChainAction } from "../stack";
import { renders } from "../testRaster";
import { asImage, SRC, testImage as image, testScene } from "../testScene";
import { EXT_KEY, type AnyDesktopExtension } from "../types";

vi.mock("../raster", () => import("../testRaster"));

const HARD = { offsetX: 2, offsetY: 3, blur: 0, opacity: 100, color: "#ff0000" };

function plan10(over: Partial<ImagePlan> = {}): ImagePlan {
  // 10×10 content at 1 px / unit.
  return {
    ...basePlan({
      element: { x: 0, y: 0, width: 10, height: 10 },
      crop: null,
      naturalWidth: 10,
      naturalHeight: 10,
      isVector: false,
    }),
    ...over,
  };
}

describe("shadow params and plan", () => {
  it("validates params", () => {
    expect(normalizeShadowParams({})).toEqual({
      offsetX: 6,
      offsetY: 6,
      blur: 8,
      color: "#000000",
      opacity: 35,
    });
    expect(() => normalizeShadowParams({ blur: -1 })).toThrow(/shadow: blur/);
    expect(() => normalizeShadowParams({ color: "black" })).toThrow(/shadow: color/);
  });

  it("pads just enough for the offset blur, never shrinking an earlier margin", () => {
    const p = normalizeShadowParams({ offsetX: 4, offsetY: -2, blur: 0 });
    expect(planShadow(plan10(), p).pad).toEqual({ left: 0, right: 4, top: 2, bottom: 0 });
    const blurred = normalizeShadowParams({ offsetX: 0, offsetY: 0, blur: 6 });
    // boxRadius(6) = 3 → reach 9 on each side.
    expect(planShadow(plan10(), blurred).pad).toEqual({ left: 9, right: 9, top: 9, bottom: 9 });
    const prev = plan10({ pad: { left: 20, right: 0, top: 0, bottom: 0 } });
    expect(planShadow(prev, p).pad).toEqual({ left: 20, right: 4, top: 2, bottom: 0 });
  });

  it("mirrors the bitmap offset when the element is flipped", () => {
    const p = normalizeShadowParams({ offsetX: 4, offsetY: 0, blur: 0 });
    const flipped = plan10({ flip: { x: true, y: false } });
    expect(planShadow(flipped, p).pad).toEqual({ left: 4, right: 0, top: 0, bottom: 0 });
  });

  it("renders the content's alpha offset, coloured, behind the content", () => {
    const p = normalizeShadowParams(HARD);
    const plan = planShadow(
      plan10({ outWidth: 2, outHeight: 2, element: { x: 0, y: 0, width: 2, height: 2 } }),
      p,
    );
    expect(plan.pad).toEqual({ left: 0, right: 2, top: 0, bottom: 3 });
    const content = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) };
    content.data[3] = 0; // top-left transparent
    const out = { width: 4, height: 5, data: new Uint8ClampedArray(4 * 5 * 4) };
    renderShadow(out, content, plan, p);
    const alphaAt = (x: number, y: number) => out.data[(y * 4 + x) * 4 + 3];
    expect(alphaAt(2, 3)).toBe(0);
    expect(alphaAt(3, 3)).toBe(255);
    expect(alphaAt(2, 4)).toBe(255);
    expect(alphaAt(1, 1)).toBe(0);
    expect([...out.data.slice((4 * 4 + 3) * 4, (4 * 4 + 3) * 4 + 4)]).toEqual([255, 0, 0, 255]);
  });

  it("scales opacity and skips at 0", () => {
    const content = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) };
    const p = normalizeShadowParams({ ...HARD, offsetX: 0, offsetY: 0, opacity: 50 });
    const plan = planShadow(
      plan10({ outWidth: 1, outHeight: 1, element: { x: 0, y: 0, width: 1, height: 1 } }),
      p,
    );
    const out = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    renderShadow(out, content, plan, p);
    expect(out.data[3]).toBe(128);
    const none = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    renderShadow(none, content, plan, { ...p, opacity: 0 });
    expect(none.data[3]).toBe(0);
  });
});

describe("shadow in the stack", () => {
  let s: ReturnType<typeof testScene>;
  beforeEach(() => {
    renders.length = 0;
    s = testScene();
  });
  async function run(el: ExcalidrawElement, ext: AnyDesktopExtension, action: ChainAction) {
    const res = await runChain(el, ext, action, s.ctx);
    s.add(res.files);
    return res.element;
  }
  const apply = (el: ExcalidrawElement, ext: AnyDesktopExtension, params = {}) =>
    run(el, ext, { kind: "apply", params });
  const remove = (el: ExcalidrawElement, ext: AnyDesktopExtension) =>
    run(el, ext, { kind: "remove" });
  const stored = (el: ExcalidrawElement) =>
    el.customData?.[EXT_KEY] as {
      chain: { ext: string }[];
      source: Record<string, unknown> & { inset?: unknown };
    };

  // Source 400×200 on a 200×100 image → 2 px / unit. Default: offset 6, blur 8 → 16 px →
  // box radius 8 → reach 24 px; offset 12 px → pad 12 / 36 px = 6 / 18 units.
  it("grows the bounds by the shadow margin so the image stays put", async () => {
    const el = await apply(image(), shadowExtension);
    expect(el).toMatchObject({ x: 4, y: 14, width: 224, height: 124 });
    expect(renders[0]!.plan.pad).toEqual({ left: 12, top: 12, right: 36, bottom: 36 });
    expect(renders[0]!.ops).toEqual(["behind"]);
    expect(stored(el).source).toMatchObject({
      fileId: SRC,
      x: 10,
      y: 20,
      width: 200,
      height: 100,
      appliedWidth: 224,
      appliedHeight: 124,
      inset: { left: 6, top: 6, right: 18, bottom: 18 },
    });
  });

  it("re-applying and removing restore around the content, also after a resize", async () => {
    let el = await apply(image(), shadowExtension);
    // Double the size around the same top-left corner.
    el = { ...el, width: 448, height: 248 } as ExcalidrawElement;
    el = await apply(el, shadowExtension, { offsetX: 0, offsetY: 0, blur: 0 });
    // Content is now 400×200 at (4 + 12, 14 + 12); a zero shadow needs no margin.
    expect(el).toMatchObject({ x: 16, y: 26, width: 400, height: 200 });
    expect(stored(el).source.inset).toBeUndefined();
    el = await apply(el, shadowExtension);
    el = await remove(el, shadowExtension);
    expect(asImage(el).fileId).toBe(SRC);
    expect(el).toMatchObject({ x: 16, y: 26, width: 400, height: 200 });
    expect(el.customData).toBeUndefined();
  });

  it("follows a flip: the margin is swapped in the scene and the original comes back", async () => {
    const flipped = image({ scale: [-1, 1] });
    const el = await apply(flipped, shadowExtension);
    // Bitmap offset is mirrored, so in the scene the shadow still falls right / down.
    expect(renders[0]!.plan.pad).toEqual({ left: 36, top: 12, right: 12, bottom: 36 });
    expect(el).toMatchObject({ x: 4, y: 14, width: 224, height: 124 });
    const back = await remove(el, shadowExtension);
    expect(back).toMatchObject({ x: 10, y: 20, width: 200, height: 100 });
  });

  it("stacks with mask, border and colour stages in canonical order, deterministically", async () => {
    const chainA = async () =>
      apply(
        await apply(
          await apply(await apply(image(), shadowExtension), maskExtension, { shape: "circle" }),
          borderExtension,
          { width: 2 },
        ),
        grayscaleExtension,
      );
    const a = await chainA();
    expect(stored(a).chain.map((l: { ext: string }) => l.ext)).toEqual([
      "grayscale",
      "mask",
      "border",
      "shadow",
    ]);
    const last = renders[renders.length - 1]!;
    expect(last.plan.outline).toEqual({ kind: "ellipse" });
    expect(last.ops[0]).toBe("pixels");
    expect(last.ops[last.ops.length - 1]).toBe("behind");
    // The circle (100×100 at x 60) plus the shadow margin.
    expect(a).toMatchObject({ x: 54, y: 14, width: 124, height: 124 });
    renders.length = 0;
    s = testScene();
    const b = await chainA();
    expect(asImage(b).fileId).toBe(asImage(a).fileId);
    // Removing the shadow brings the masked circle back to its own box.
    const noShadow = await remove(a, shadowExtension);
    expect(noShadow).toMatchObject({ x: 60, y: 20, width: 100, height: 100 });
    expect(stored(noShadow).source.inset).toBeUndefined();
  });

  it("treats an impossible stored margin as damaged", async () => {
    const el = await apply(image(), shadowExtension);
    const bad = {
      ...el,
      customData: {
        [EXT_KEY]: {
          ...stored(el),
          source: { ...stored(el).source, inset: { left: 200, top: 0, right: 100, bottom: 0 } },
        },
      },
    } as ExcalidrawElement;
    expect(readStack(bad)).toMatchObject({
      kind: "unreadable",
      reason: expect.stringMatching(/damaged/),
    });
  });
});
