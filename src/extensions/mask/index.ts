/**
 * Mask extension: masks an image element to a circle or rounded rectangle.
 *
 * Intent (shape, original file/bounds/crop) lives in
 * `element.customData[EXT_KEY]`; the visible result is a standard PNG
 * `BinaryFile` with the mask baked into its alpha channel, so the scene
 * renders identically in stock Excalidraw, exports, collab and excalidraw.com.
 */
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
  ImageCrop,
} from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import { EXT_KEY } from "../types";
import type { DesktopExtension, ExtensionContext, ExtensionIntent } from "../types";
import {
  maskFileId,
  maskParamsSchema,
  normalizeMaskParams,
  planMask,
  restoreBounds,
  type MaskParams,
} from "./geometry";
import { loadSource } from "./raster";

export type { MaskParams } from "./geometry";

const ID = "mask";
const VERSION = 1;

/** Stored in `intent.source`: everything needed to undo or re-derive the mask. */
type MaskSource = {
  fileId: FileId;
  x: number;
  y: number;
  width: number;
  height: number;
  crop: ImageCrop | null;
  /** Element size right after masking; used to carry later resizes back on remove. */
  appliedWidth: number;
  appliedHeight: number;
};

type Base = {
  fileId: FileId;
  x: number;
  y: number;
  width: number;
  height: number;
  crop: ImageCrop | null;
};

function isImage(el: ExcalidrawElement): el is ExcalidrawImageElement {
  return el.type === "image";
}

function rawIntent(el: ExcalidrawElement): ExtensionIntent | null {
  const v = (el.customData as Record<string, unknown> | undefined)?.[EXT_KEY];
  if (!v || typeof v !== "object") return null;
  const intent = v as ExtensionIntent;
  return intent.ext === ID ? intent : null;
}

function readSource(intent: ExtensionIntent): MaskSource | null {
  const s = intent.source as Partial<MaskSource> | undefined;
  if (!s || typeof s.fileId !== "string") return null;
  const nums = [s.x, s.y, s.width, s.height, s.appliedWidth, s.appliedHeight];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return s as MaskSource;
}

function getIntent(el: ExcalidrawElement): ExtensionIntent | null {
  if (!isImage(el)) return null;
  const intent = rawIntent(el);
  if (!intent || !intent.outputFileId || intent.outputFileId !== el.fileId) return null;
  return readSource(intent) ? intent : null;
}

/** The un-masked state of `el`: its stored original if currently masked, else itself. */
function baseOf(el: ExcalidrawImageElement): Base {
  const intent = getIntent(el);
  const src = intent && readSource(intent);
  if (src) {
    const b = restoreBounds(
      el,
      { width: src.appliedWidth, height: src.appliedHeight },
      { width: src.width, height: src.height },
    );
    return { fileId: src.fileId, ...b, crop: src.crop };
  }
  if (!el.fileId) throw new Error("mask: image has no file");
  return { fileId: el.fileId, x: el.x, y: el.y, width: el.width, height: el.height, crop: el.crop };
}

function withCustomData(
  el: ExcalidrawElement,
  intent: ExtensionIntent | undefined,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...(el.customData ?? {}) };
  if (intent) next[EXT_KEY] = intent;
  else delete next[EXT_KEY];
  return Object.keys(next).length ? next : undefined;
}

function bump<T extends ExcalidrawElement>(el: T, patch: Partial<ExcalidrawImageElement>): T {
  return {
    ...el,
    ...patch,
    version: el.version + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  } as T;
}

function requireFile(ctx: ExtensionContext, id: FileId, what: string): BinaryFileData {
  const f = ctx.getFile(id);
  if (!f) throw new Error(`mask: ${what} image file is not available in this scene`);
  return f;
}

export const maskExtension: DesktopExtension<MaskParams> = {
  id: ID,
  version: VERSION,
  title: "Mask",
  paramsSchema: maskParamsSchema,
  presets: [
    { id: "circle", label: "Circle", params: { shape: "circle" } },
    {
      id: "roundedRect",
      label: "Rounded rectangle",
      params: { shape: "roundedRect", radius: 15 },
    },
  ],

  appliesTo(el) {
    return isImage(el) && !!el.fileId && el.status !== "error" && !el.isDeleted;
  },

  getIntent,

  async apply(el, rawParams, ctx) {
    if (!isImage(el)) throw new Error("mask: only image elements can be masked");
    const params = normalizeMaskParams(rawParams);
    // Always derive from the original so we never mask a mask.
    const base = baseOf(el);
    const file = requireFile(ctx, base.fileId, "source");
    const source = await loadSource(file);
    const plan = planMask({
      params,
      element: base,
      crop: base.crop,
      naturalWidth: source.naturalWidth,
      naturalHeight: source.naturalHeight,
      isVector: file.mimeType === "image/svg+xml",
    });
    const outputFileId = maskFileId(base.fileId, plan, VERSION) as FileId;
    const outFile: BinaryFileData = ctx.getFile(outputFileId) ?? {
      id: outputFileId,
      mimeType: "image/png",
      dataURL: (await source.render(plan)) as DataURL,
      created: Date.now(),
    };
    const src: MaskSource = {
      ...base,
      appliedWidth: plan.element.width,
      appliedHeight: plan.element.height,
    };
    const intent: ExtensionIntent = {
      ext: ID,
      v: VERSION,
      params: { ...params },
      source: { ...src },
      outputFileId,
    };
    const element = bump(el, {
      ...plan.element,
      fileId: outputFileId,
      crop: null,
      customData: withCustomData(el, intent),
    });
    return { element, files: [outFile] };
  },

  async remove(el, ctx) {
    if (!isImage(el)) throw new Error("mask: not an image element");
    if (!rawIntent(el)) throw new Error("mask: element is not masked");
    const intent = getIntent(el);
    if (!intent) {
      // Stale intent (file was replaced elsewhere): just drop the metadata.
      return { element: bump(el, { customData: withCustomData(el, undefined) }), files: [] };
    }
    const base = baseOf(el);
    const original = requireFile(ctx, base.fileId, "original");
    const element = bump(el, {
      fileId: base.fileId,
      x: base.x,
      y: base.y,
      width: base.width,
      height: base.height,
      crop: base.crop,
      customData: withCustomData(el, undefined),
    });
    return { element, files: [original] };
  },
};
