import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import { borderExtension } from "./border";
import { maskExtension } from "./mask";
import {
  canonicalChain,
  extensionStateOf,
  readStack,
  runChain,
  sceneFileIds,
  type ChainAction,
} from "./stack";
import { renders } from "./testRaster";
import { asImage, SRC, testImage as image, testScene } from "./testScene";
import { EXT_KEY, type AnyDesktopExtension } from "./types";

vi.mock("./raster", () => import("./testRaster"));

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
const apply = (el: ExcalidrawElement, ext: AnyDesktopExtension, params: Record<string, unknown>) =>
  run(el, ext, { kind: "apply", params });
const remove = (el: ExcalidrawElement, ext: AnyDesktopExtension) =>
  run(el, ext, { kind: "remove" });
const stored = (el: ExcalidrawElement) => el.customData?.[EXT_KEY] as Record<string, unknown>;
const lastOps = () => renders[renders.length - 1]!.ops;

const CIRCLE = { shape: "circle" };
const THICK_BLUE = { width: 8, color: "#1971c2" };

describe("extension stacks", () => {
  it("keeps one canonical order: shapes before decorations, one link per extension", () => {
    const chain = canonicalChain([
      { ext: "border", v: 1, params: { width: 1 } },
      { ext: "mask", v: 1, params: CIRCLE },
      { ext: "border", v: 1, params: { width: 2 } },
    ]);
    expect(chain.map((l) => [l.ext, l.params])).toEqual([
      ["mask", CIRCLE],
      ["border", { width: 2 }],
    ]);
  });

  it("border on an unmasked image strokes the full rectangle inside its bounds", async () => {
    const el = await apply(image(), borderExtension, THICK_BLUE);
    expect(el).toMatchObject({ x: 10, y: 20, width: 200, height: 100 });
    const r = renders[0]!;
    expect(r.plan.outline).toEqual({ kind: "rect" });
    // 400px source over 200 scene units = 2 px/unit; stroked at 2× so the inner half is 8 units.
    expect(r.ops).toEqual([
      "globalAlpha=1",
      "strokeStyle=#1971c2",
      "lineWidth=32",
      "lineJoin=miter",
      "beginPath()",
      "rect(0,0,400,200)",
      "stroke()",
    ]);
  });

  it("border traces the mask outline whichever is applied first", async () => {
    const a = await apply(await apply(image(), maskExtension, CIRCLE), borderExtension, THICK_BLUE);
    expect(lastOps()).toContain("ellipse(100,100,100,100,0,0,6.283)");
    expect(renders[1]!.plan.outline).toEqual({ kind: "ellipse" });
    const b = await apply(await apply(image(), borderExtension, THICK_BLUE), maskExtension, CIRCLE);
    expect(asImage(b).fileId).toBe(asImage(a).fileId);
    expect(stored(b).chain).toEqual([
      { ext: "mask", v: 1, params: CIRCLE },
      { ext: "border", v: 1, params: { width: 8, color: "#1971c2", opacity: 100 } },
    ]);
    expect(b).toMatchObject({ x: 60, y: 20, width: 100, height: 100 });
  });

  it("re-parameterising one link keeps the others and re-renders from the original", async () => {
    let el = await apply(await apply(image(), maskExtension, CIRCLE), borderExtension, THICK_BLUE);
    el = await apply(el, borderExtension, { width: 2, color: "#1971c2" });
    expect(stored(el).chain).toMatchObject([
      { ext: "mask" },
      { ext: "border", params: { width: 2 } },
    ]);
    expect(renders.every((r) => r.source === SRC)).toBe(true);
    expect(lastOps()).toContain("lineWidth=8");
    expect(extensionStateOf(el)?.applied).toEqual({
      mask: CIRCLE,
      border: { width: 2, color: "#1971c2", opacity: 100 },
    });
  });

  it("removing the mask keeps the border and re-traces it to the restored rectangle", async () => {
    let el = await apply(await apply(image(), maskExtension, CIRCLE), borderExtension, THICK_BLUE);
    el = await remove(el, maskExtension);
    expect(el.x).toBeCloseTo(10);
    expect(el.width).toBeCloseTo(200);
    expect(el.height).toBeCloseTo(100);
    expect(renders[renders.length - 1]!.plan.outline).toEqual({ kind: "rect" });
    expect(lastOps()).toContain("rect(0,0,400,200)");
    expect(stored(el).chain).toMatchObject([{ ext: "border" }]);
    expect((stored(el).source as { fileId: string }).fileId).toBe(SRC);
  });

  it("removing the border keeps the mask; removing the last link restores the original", async () => {
    const original = image({ customData: { other: 1 } });
    const masked = await apply(original, maskExtension, CIRCLE);
    let el = await apply(masked, borderExtension, THICK_BLUE);
    el = await remove(el, borderExtension);
    expect(stored(el).chain).toMatchObject([{ ext: "mask" }]);
    // Same chain as before the border → the mask-only PNG is reused, not re-rendered.
    expect(asImage(el).fileId).toBe(asImage(masked).fileId);
    expect(renders).toHaveLength(2);
    el = await remove(el, maskExtension);
    expect(asImage(el)).toMatchObject({ fileId: SRC, crop: null, customData: { other: 1 } });
    expect(el.x).toBeCloseTo(10);
    expect(el.width).toBeCloseTo(200);
  });

  it("carries resizes made since rendering back to the original", async () => {
    let el = await apply(image(), borderExtension, THICK_BLUE);
    el = { ...el, x: 0, y: 0, width: 400, height: 200 } as ExcalidrawElement;
    el = await apply(el, maskExtension, CIRCLE);
    expect(el).toMatchObject({ x: 100, y: 0, width: 200, height: 200 });
    expect(stored(el).source).toMatchObject({ x: 0, y: 0, width: 400, height: 200 });
  });

  it("reports and refuses stale stacks as fresh originals", async () => {
    s.add([{ ...s.ctx.getFile(SRC)!, id: "swapped" as FileId }]);
    const el = await apply(
      await apply(image(), maskExtension, CIRCLE),
      borderExtension,
      THICK_BLUE,
    );
    const swapped = { ...el, fileId: "swapped" } as ExcalidrawElement;
    expect(extensionStateOf(swapped)).toEqual({ applied: {}, stale: ["mask", "border"] });
    const fresh = await apply(swapped, borderExtension, {});
    expect(stored(fresh).chain).toMatchObject([{ ext: "border" }]);
    expect(stored(fresh).source).toMatchObject({ fileId: "swapped", width: 100 });
  });
});

describe("v1 single-extension format", () => {
  async function legacyMasked() {
    const el = await apply(image(), maskExtension, CIRCLE);
    const { chain, ...rest } = stored(el) as {
      chain: { params: unknown }[];
      source: unknown;
      outputFileId: string;
    };
    const v1 = {
      ext: "mask",
      v: 1,
      params: chain[0]!.params,
      source: rest.source,
      outputFileId: rest.outputFileId,
    };
    return { ...el, customData: { [EXT_KEY]: v1 } } as ExcalidrawElement;
  }

  it("migrates on read", async () => {
    const el = await legacyMasked();
    const read = readStack(el);
    expect(read).toMatchObject({ kind: "ok", legacy: true, current: true });
    expect(extensionStateOf(el)).toEqual({ applied: { mask: CIRCLE }, stale: [] });
    expect(sceneFileIds([el])).toEqual([asImage(el).fileId, SRC]);
  });

  it("writes the v2 stack on the next apply, keeping the mask", async () => {
    const el = await apply(await legacyMasked(), borderExtension, { width: 2 });
    expect(stored(el)).toMatchObject({
      v: 2,
      chain: [{ ext: "mask" }, { ext: "border" }],
      source: { fileId: SRC, width: 200, height: 100 },
    });
    expect(stored(el).ext).toBeUndefined();
  });

  it("removes back to the original", async () => {
    const el = await remove(await legacyMasked(), maskExtension);
    expect(asImage(el).fileId).toBe(SRC);
    expect(el.customData).toBeUndefined();
  });
});

describe("unreadable stacks", () => {
  const src = {
    fileId: SRC,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    crop: null,
    appliedWidth: 1,
    appliedHeight: 1,
  };
  const withRaw = (raw: unknown) =>
    image({ fileId: "out" as FileId, customData: { [EXT_KEY]: raw } });

  it.each([
    [
      "a newer stack format",
      { v: 3, chain: [{ ext: "mask", v: 1, params: CIRCLE }], source: src, outputFileId: "out" },
      /newer version/,
    ],
    [
      "a newer link version",
      { v: 2, chain: [{ ext: "mask", v: 9, params: CIRCLE }], source: src, outputFileId: "out" },
      /Mask was saved by a newer/,
    ],
    [
      "an unknown extension",
      { v: 2, chain: [{ ext: "glow", v: 1, params: {} }], source: src, outputFileId: "out" },
      /unknown extension "glow"/,
    ],
    [
      "invalid params",
      {
        v: 2,
        chain: [{ ext: "mask", v: 1, params: { shape: "star" } }],
        source: src,
        outputFileId: "out",
      },
      /Mask settings are invalid/,
    ],
    [
      "a damaged source",
      {
        v: 2,
        chain: [{ ext: "mask", v: 1, params: CIRCLE }],
        source: { fileId: SRC },
        outputFileId: "out",
      },
      /damaged/,
    ],
  ])("%s: reported stale, files kept, edits refused", async (_name, raw, reason) => {
    const el = withRaw(raw);
    const read = readStack(el);
    expect(read.kind).toBe("unreadable");
    expect(read.kind === "unreadable" && read.reason).toMatch(reason);
    expect(extensionStateOf(el)?.applied).toEqual({});
    expect(extensionStateOf(el)?.stale.length).toBeGreaterThan(0);
    expect(sceneFileIds([el])).toEqual(["out", SRC]);
    await expect(apply(el, borderExtension, {})).rejects.toThrow(/can't be edited/);
  });
});
