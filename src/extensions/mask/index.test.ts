import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import { EXT_KEY } from "../types";
import type { ExtensionContext } from "../types";
import type { MaskPlan } from "./geometry";

const render = vi.fn(
  async (plan: MaskPlan) =>
    `data:image/png;base64,${plan.shape}-${plan.outWidth}x${plan.outHeight}`,
);
vi.mock("./raster", () => ({
  loadSource: vi.fn(async () => ({ naturalWidth: 400, naturalHeight: 200, render })),
}));

const { maskExtension } = await import("./index");

const SRC = "srcfile" as FileId;

function image(over: Partial<ExcalidrawImageElement> = {}): ExcalidrawImageElement {
  return {
    id: "img1",
    type: "image",
    x: 10,
    y: 20,
    width: 200,
    height: 100,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 3,
    versionNonce: 1,
    index: null,
    isDeleted: false,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
    fileId: SRC,
    status: "saved",
    scale: [1, 1],
    crop: null,
    ...over,
  } as ExcalidrawImageElement;
}

function scene() {
  const files = new Map<string, BinaryFileData>([
    [
      SRC,
      {
        id: SRC,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,orig" as DataURL,
        created: 0,
      },
    ],
  ]);
  const ctx: ExtensionContext = { getFile: (id) => files.get(id) };
  const add = (fs: BinaryFileData[]) => fs.forEach((f) => files.set(f.id, f));
  return { files, ctx, add };
}

const asImage = (el: ExcalidrawElement) => el as ExcalidrawImageElement;

beforeEach(() => {
  render.mockClear();
});

describe("maskExtension", () => {
  it("applies to loaded image elements only", () => {
    expect(maskExtension.appliesTo(image())).toBe(true);
    expect(maskExtension.appliesTo(image({ fileId: null }))).toBe(false);
    expect(maskExtension.appliesTo(image({ status: "error" }))).toBe(false);
    expect(maskExtension.appliesTo({ ...image(), type: "rectangle" } as never)).toBe(false);
  });

  it("circle: bakes a square PNG, records intent, keeps flips and other customData", async () => {
    const { ctx } = scene();
    const el = image({ scale: [-1, 1], customData: { other: 1 } });
    const { element, files } = await maskExtension.apply(el, { shape: "circle" }, ctx);
    const out = asImage(element);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ mimeType: "image/png", id: out.fileId });
    expect(files[0].dataURL).toBe("data:image/png;base64,circle-200x200");
    expect(out).toMatchObject({ x: 60, y: 20, width: 100, height: 100, crop: null });
    expect(out.scale).toEqual([-1, 1]);
    expect(out.version).toBe(4);
    expect(out.customData?.other).toBe(1);
    const intent = maskExtension.getIntent(out);
    expect(intent).toMatchObject({
      ext: "mask",
      v: 1,
      params: { shape: "circle" },
      outputFileId: out.fileId,
      source: { fileId: SRC, x: 10, y: 20, width: 200, height: 100, crop: null },
    });
  });

  it("remove restores fileId, bounds and crop and drops only our metadata", async () => {
    const { ctx, add } = scene();
    const crop = { x: 0, y: 0, width: 300, height: 150, naturalWidth: 400, naturalHeight: 200 };
    const el = image({ crop, customData: { other: 1 } });
    const applied = await maskExtension.apply(el, { shape: "circle" }, ctx);
    add(applied.files);
    const { element } = await maskExtension.remove(applied.element, ctx);
    const out = asImage(element);
    expect(out.fileId).toBe(SRC);
    expect(out.crop).toEqual(crop);
    expect(out.x).toBeCloseTo(10);
    expect(out.y).toBeCloseTo(20);
    expect(out.width).toBeCloseTo(200);
    expect(out.height).toBeCloseTo(100);
    expect(out.customData).toEqual({ other: 1 });
    expect(maskExtension.getIntent(out)).toBeNull();
  });

  it("removes customData entirely when ours was the only key", async () => {
    const { ctx } = scene();
    const applied = await maskExtension.apply(image(), { shape: "circle" }, ctx);
    const { element } = await maskExtension.remove(applied.element, ctx);
    expect(element.customData).toBeUndefined();
  });

  it("re-applying derives from the original, not the mask", async () => {
    const { ctx, add } = scene();
    const first = await maskExtension.apply(image(), { shape: "circle" }, ctx);
    add(first.files);
    const second = await maskExtension.apply(
      first.element,
      { shape: "roundedRect", radius: 10 },
      ctx,
    );
    const out = asImage(second.element);
    expect(out).toMatchObject({ width: 200, height: 100 });
    expect(out.x).toBeCloseTo(10);
    expect(maskExtension.getIntent(out)?.source).toMatchObject({ fileId: SRC, width: 200 });
    expect(second.files[0].dataURL).toBe("data:image/png;base64,roundedRect-400x200");
  });

  it("produces deterministic file ids and reuses an existing output file", async () => {
    const { ctx, add } = scene();
    const a = await maskExtension.apply(image(), { shape: "circle" }, ctx);
    add(a.files);
    const b = await maskExtension.apply(a.element, { shape: "circle" }, ctx);
    expect(asImage(b.element).fileId).toBe(asImage(a.element).fileId);
    expect(b.files[0]).toBe(a.files[0]);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("treats intent as stale when the file was swapped", async () => {
    const { ctx } = scene();
    const applied = await maskExtension.apply(image(), { shape: "circle" }, ctx);
    const swapped = { ...applied.element, fileId: "other" as FileId } as ExcalidrawImageElement;
    expect(maskExtension.getIntent(swapped)).toBeNull();
    const { element, files } = await maskExtension.remove(swapped, ctx);
    expect(asImage(element).fileId).toBe("other");
    expect(element.customData?.[EXT_KEY]).toBeUndefined();
    expect(files).toEqual([]);
  });

  it("errors clearly on bad params, missing files and unmasked removal", async () => {
    const { ctx, files } = scene();
    await expect(maskExtension.apply(image(), { shape: "star" } as never, ctx)).rejects.toThrow(
      /shape/,
    );
    await expect(maskExtension.remove(image(), ctx)).rejects.toThrow(/not masked/);
    const applied = await maskExtension.apply(image(), { shape: "circle" }, ctx);
    files.delete(SRC);
    await expect(maskExtension.remove(applied.element, ctx)).rejects.toThrow(/original/);
    await expect(maskExtension.apply(image(), { shape: "circle" }, ctx)).rejects.toThrow(/source/);
  });
});
