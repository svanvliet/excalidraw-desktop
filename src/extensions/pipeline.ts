/**
 * Pure geometry shared by every image extension (docs/extensions.md § Stacking): the base plan for
 * an image (which source pixels are visible, output raster size, element bounds, outline), the
 * outline path, bounds restoration, and deterministic output file ids. No DOM here, so it is
 * unit-testable in jsdom; the canvas work lives in raster.ts.
 *
 * Coordinate systems:
 * - "source" = pixels of the decoded image (`naturalWidth × naturalHeight`). Excalidraw's
 *   `element.crop` is expressed in this space (scaled by `crop.naturalWidth` in case the file was
 *   re-encoded at a different size).
 * - "display" = scene units of the element box (`width × height`).
 * - "output" = pixels of the baked PNG (`outWidth × outHeight`).
 */
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
} from "@excalidraw/excalidraw/element/types";

/** Longest side of the baked PNG, in pixels. */
export const MAX_OUTPUT_PX = 1024;
/** Minimum px per display unit for vector (SVG) sources, which have no intrinsic resolution. */
export const VECTOR_DENSITY = 2;

export type Rect = { x: number; y: number; width: number; height: number };

export type CropLike = Rect & { naturalWidth: number; naturalHeight: number };

/** The visible shape of the output, in output pixels (always fills the output canvas). */
export type Outline =
  | { kind: "rect" }
  | { kind: "ellipse" }
  | { kind: "roundedRect"; radiusPx: number };

export type ImagePlan = {
  /** Region of the source image to draw, in source pixels. */
  sourceRect: Rect;
  /** Element bounds in scene units. */
  element: Rect;
  /** Desired output px per display unit, before the MAX_OUTPUT_PX cap. */
  density: number;
  /** Output canvas size in pixels. */
  outWidth: number;
  outHeight: number;
  /** Shape the output is clipped to; later stages (e.g. border) trace it. */
  outline: Outline;
};

/** Image elements extensions can work on: loaded, not deleted. */
export function isLoadedImage(el: ExcalidrawElement): el is ExcalidrawImageElement {
  return el.type === "image" && !!el.fileId && el.status !== "error" && !el.isDeleted;
}

/** The part of the source image currently shown by the element (honours `crop`). */
export function visibleSourceRect(
  crop: CropLike | null,
  naturalWidth: number,
  naturalHeight: number,
): Rect {
  if (!crop) return { x: 0, y: 0, width: naturalWidth, height: naturalHeight };
  const kx = crop.naturalWidth > 0 ? naturalWidth / crop.naturalWidth : 1;
  const ky = crop.naturalHeight > 0 ? naturalHeight / crop.naturalHeight : 1;
  return { x: crop.x * kx, y: crop.y * ky, width: crop.width * kx, height: crop.height * ky };
}

export function clampPx(v: number): number {
  return Math.max(1, Math.min(MAX_OUTPUT_PX, Math.round(v)));
}

/** Output size for a `width × height` display box at `density`, longest side capped. */
export function fitOutput(
  width: number,
  height: number,
  density: number,
): { outWidth: number; outHeight: number } {
  let w = width * density;
  let h = height * density;
  const longest = Math.max(w, h);
  if (longest > MAX_OUTPUT_PX) {
    w = (w * MAX_OUTPUT_PX) / longest;
    h = (h * MAX_OUTPUT_PX) / longest;
  }
  return { outWidth: clampPx(w), outHeight: clampPx(h) };
}

/**
 * The un-decorated plan for an image: the visible (cropped) source drawn into the element's box,
 * rectangular outline. Flips (`element.scale`) are intentionally not baked: Excalidraw mirrors the
 * whole drawn box, and every outline is centred and symmetric, so the output is flip-invariant
 * and keeps the element's `scale`.
 */
export function basePlan(opts: {
  element: Rect;
  crop: CropLike | null;
  naturalWidth: number;
  naturalHeight: number;
  isVector?: boolean;
}): ImagePlan {
  const { element: el } = opts;
  if (!(el.width > 0) || !(el.height > 0)) throw new Error("image has no size");
  // SVGs without intrinsic size decode as 0×0; treat the display box as the source.
  const nw = opts.naturalWidth > 0 ? opts.naturalWidth : (opts.crop?.naturalWidth ?? el.width);
  const nh = opts.naturalHeight > 0 ? opts.naturalHeight : (opts.crop?.naturalHeight ?? el.height);
  const src = visibleSourceRect(opts.crop, nw, nh);
  const density = Math.max(
    src.width / el.width,
    src.height / el.height,
    opts.isVector ? VECTOR_DENSITY : 0,
  );
  return {
    sourceRect: src,
    element: { x: el.x, y: el.y, width: el.width, height: el.height },
    density,
    ...fitOutput(el.width, el.height, density),
    outline: { kind: "rect" },
  };
}

/** Output pixels per scene unit of the planned element (for stages sized in scene units). */
export function outputScale(plan: ImagePlan): number {
  return plan.outWidth / plan.element.width;
}

/** Minimal path API (a CanvasRenderingContext2D satisfies it) so this stays DOM-free. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
  ): void;
  rect(x: number, y: number, w: number, h: number): void;
  closePath(): void;
}

/** Adds the plan's outline to the current path (call `beginPath` first). */
export function outlinePath(ctx: PathSink, plan: ImagePlan): void {
  const w = plan.outWidth;
  const h = plan.outHeight;
  const o = plan.outline;
  if (o.kind === "ellipse") {
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  const r = o.kind === "roundedRect" ? Math.max(0, Math.min(o.radiusPx, w / 2, h / 2)) : 0;
  if (r === 0) {
    ctx.rect(0, 0, w, h);
    return;
  }
  // Manual path rather than ctx.roundRect for older WebKit (macOS 12 WKWebView).
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.arcTo(w, 0, w, r, r);
  ctx.lineTo(w, h - r);
  ctx.arcTo(w, h, w - r, h, r);
  ctx.lineTo(r, h);
  ctx.arcTo(0, h, 0, h - r, r);
  ctx.lineTo(0, r);
  ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
}

/**
 * Bounds to restore on removal. Keeps the element's current centre (so a moved image restores in
 * place) and scales the original size by any resize applied since the chain was rendered. With no
 * edits this returns the original bounds exactly (up to float rounding).
 */
export function restoreBounds(
  current: Rect,
  applied: { width: number; height: number },
  original: { width: number; height: number },
): Rect {
  const sx = applied.width > 0 ? current.width / applied.width : 1;
  const sy = applied.height > 0 ? current.height / applied.height : 1;
  const width = original.width * sx;
  const height = original.height * sy;
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** cyrb53-style 53-bit hash, seeded; returns 14 hex chars. */
function hash53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Stable JSON (sorted keys) so equal params always hash the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Deterministic output file id: identical source file + final plan + chain → identical id, so
 * re-applying never bloats `files`. 40 hex chars to match Excalidraw's own (SHA-1) file ids.
 */
export function outputFileId(
  sourceFileId: string,
  plan: ImagePlan,
  chain: readonly { ext: string; v: number; params: Record<string, unknown> }[],
): string {
  const r = plan.sourceRect;
  const key = stable([
    "stack",
    sourceFileId,
    [r.x, r.y, r.width, r.height].map(round4),
    // Element size matters: stages sized in scene units (border width) scale with it.
    [plan.element.width, plan.element.height].map(round4),
    plan.outWidth,
    plan.outHeight,
    plan.outline.kind === "roundedRect"
      ? ["roundedRect", round4(plan.outline.radiusPx)]
      : plan.outline.kind,
    chain.map((l) => [l.ext, l.v, l.params]),
  ]);
  return (hash53(key, 1) + hash53(key, 2) + hash53(key, 3)).slice(0, 40);
}
