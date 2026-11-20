import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImageElement, FileId } from "@excalidraw/excalidraw/element/types";
import { readStack, runChain } from "../stack";
import { renders } from "../testRaster";
import { asImage, SRC, testImage as image, testScene as scene } from "../testScene";
import { EXT_KEY } from "../types";
import { maskExtension } from "./index";

vi.mock("../raster", () => import("../testRaster"));

const apply = (el: Parameters<typeof runChain>[0], params: unknown, ctx: Parameters<typeof runChain>[3]) =>
  runChain(el, maskExtension, { kind: "apply", params: params as never }, ctx);
const remove = (el: Parameters<typeof runChain>[0], ctx: Parameters<typeof runChain>[3]) =>
  runChain(el, maskExtension, { kind: "remove" }, ctx);

beforeEach(() => {
  renders.length = 0;
});

describe("maskExtension", () => {
  it("applies to loaded image elements only", () => {
    expect(maskExtension.appliesTo(image())).toBe(true);
    expect(maskExtension.appliesTo(image({ fileId: null }))).toBe(false);
    expect(maskExtension.appliesTo(image({ status: "error" }))).toBe(false);
    expect(maskExtension.appliesTo({ ...image(), type: "rectangle" } as never)).toBe(false);
  });

  it("circle: bakes a square PNG, records the stack, keeps flips and other customData", async () => {
    const { ctx } = scene();
    const el = image({ scale: [-1, 1], customData: { other: 1 } });
    const { element, files } = await apply(el, { shape: "circle" }, ctx);
    const out = asImage(element);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ mimeType: "image/png", id: out.fileId });
    expect(files[0].dataURL).toBe("data:image/png;base64,ellipse-200x200-0");
    expect(out).toMatchObject({ x: 60, y: 20, width: 100, height: 100, crop: null });
    expect(out.scale).toEqual([-1, 1]);
    expect(out.version).toBe(4);
    expect(out.customData?.other).toBe(1);
    expect(out.customData?.[EXT_KEY]).toEqual({
      v: 2,
      chain: [{ ext: "mask", v: 1, params: { shape: "circle" } }],
      outputFileId: out.fileId,
      source: {
        fileId: SRC,
        x: 10,
        y: 20,
        width: 200,
        height: 100,
        crop: null,
        appliedWidth: 100,
        appliedHeight: 100,
      },
    });
  });

  it("remove restores fileId, bounds and crop and drops only our metadata", async () => {
    const { ctx, add } = scene();
    const crop = { x: 0, y: 0, width: 300, height: 150, naturalWidth: 400, naturalHeight: 200 };
    const el = image({ crop, customData: { other: 1 } });
    const applied = await apply(el, { shape: "circle" }, ctx);
    add(applied.files);
    const { element } = await remove(applied.element, ctx);
    const out = asImage(element);
    expect(out.fileId).toBe(SRC);
    expect(out.crop).toEqual(crop);
    expect(out.x).toBeCloseTo(10);
    expect(out.y).toBeCloseTo(20);
    expect(out.width).toBeCloseTo(200);
    expect(out.height).toBeCloseTo(100);
    expect(out.customData).toEqual({ other: 1 });
    expect(readStack(out).kind).toBe("none");
  });

  it("removes customData entirely when ours was the only key", async () => {
    const { ctx } = scene();
    const applied = await apply(image(), { shape: "circle" }, ctx);
    const { element } = await remove(applied.element, ctx);
    expect(element.customData).toBeUndefined();
  });

  it("re-applying derives from the original, not the mask", async () => {
    const { ctx, add } = scene();
    const first = await apply(image(), { shape: "circle" }, ctx);
    add(first.files);
    const second = await apply(first.element, { shape: "roundedRect", radius: 10 }, ctx);
    const out = asImage(second.element);
    expect(out).toMatchObject({ width: 200, height: 100 });
    expect(out.x).toBeCloseTo(10);
    const read = readStack(out);
    expect(read.kind === "ok" && read.stack.source).toMatchObject({ fileId: SRC, width: 200 });
    expect(second.files[0].dataURL).toBe("data:image/png;base64,roundedRect-400x200-0");
    expect(renders.map((r) => r.source)).toEqual([SRC, SRC]);
  });

  it("produces deterministic file ids and reuses an existing output file", async () => {
    const { ctx, add } = scene();
    const a = await apply(image(), { shape: "circle" }, ctx);
    add(a.files);
    const b = await apply(a.element, { shape: "circle" }, ctx);
    expect(asImage(b.element).fileId).toBe(asImage(a.element).fileId);
    expect(b.files[0]).toBe(a.files[0]);
    expect(renders).toHaveLength(1);
  });

  it("treats a swapped file as a fresh original", async () => {
    const { ctx, add } = scene();
    add([{ ...ctx.getFile(SRC)!, id: "other" as FileId }]);
    const applied = await apply(image(), { shape: "circle" }, ctx);
    const swapped = { ...applied.element, fileId: "other" as FileId } as ExcalidrawImageElement;
    const read = readStack(swapped);
    expect(read.kind === "ok" && read.current).toBe(false);
    await expect(remove(swapped, ctx)).rejects.toThrow(/not applied/);
    const again = await apply(swapped, { shape: "circle" }, ctx);
    const r2 = readStack(again.element);
    expect(r2.kind === "ok" && r2.stack.source.fileId).toBe("other");
  });

  it("errors clearly on bad params, missing files and unmasked removal", async () => {
    const { ctx, files } = scene();
    await expect(apply(image(), { shape: "star" }, ctx)).rejects.toThrow(/shape/);
    await expect(remove(image(), ctx)).rejects.toThrow(/not applied/);
    const applied = await apply(image(), { shape: "circle" }, ctx);
    files.delete(SRC);
    await expect(remove(applied.element, ctx)).rejects.toThrow(/original/);
    await expect(apply(image(), { shape: "circle" }, ctx)).rejects.toThrow(/not available/);
  });
});
