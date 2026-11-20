/**
 * Pure geometry for the mask extension: params validation, which source pixels
 * become visible, output raster size, new element bounds, and deterministic
 * output file ids. No DOM / canvas here so it is unit-testable in jsdom.
 *
 * Coordinate systems:
 * - "source" = pixels of the decoded image (`naturalWidth × naturalHeight`).
 *   Excalidraw's `element.crop` is expressed in this space (scaled by
 *   `crop.naturalWidth` in case the file was re-encoded at a different size).
 * - "display" = scene units of the element box (`width × height`).
 */

export type MaskShape = "circle" | "roundedRect";

export type MaskParams = {
  shape: MaskShape;
  /** Corner radius for `roundedRect`, in % of the shorter side (0–50). */
  radius?: number;
};

export const DEFAULT_RADIUS = 15;
/** Longest side of the baked PNG, in pixels. */
export const MAX_OUTPUT_PX = 1024;
/** Minimum px per display unit for vector (SVG) sources, which have no intrinsic resolution. */
export const VECTOR_DENSITY = 2;

export const maskParamsSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["shape"],
  properties: {
    shape: { type: "string", enum: ["circle", "roundedRect"] },
    radius: {
      type: "number",
      minimum: 0,
      maximum: 50,
      default: DEFAULT_RADIUS,
      description: "roundedRect corner radius, % of the shorter side",
    },
  },
};

/** Validates unknown input and fills defaults. Throws a readable Error on bad input. */
export function normalizeMaskParams(input: unknown): MaskParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("mask: params must be an object");
  }
  const p = input as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (k !== "shape" && k !== "radius") throw new Error(`mask: unknown param "${k}"`);
  }
  if (p.shape === "circle") {
    if (p.radius !== undefined) throw new Error("mask: radius only applies to roundedRect");
    return { shape: "circle" };
  }
  if (p.shape === "roundedRect") {
    const radius = p.radius === undefined ? DEFAULT_RADIUS : p.radius;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0 || radius > 50) {
      throw new Error("mask: radius must be a number between 0 and 50");
    }
    return { shape: "roundedRect", radius };
  }
  throw new Error('mask: shape must be "circle" or "roundedRect"');
}

export type Rect = { x: number; y: number; width: number; height: number };

export type CropLike = Rect & { naturalWidth: number; naturalHeight: number };

export type MaskPlan = {
  /** Region of the source image to draw, in source pixels. */
  sourceRect: Rect;
  /** Output canvas size in pixels. */
  outWidth: number;
  outHeight: number;
  /** Corner radius in output pixels; for circle this is `outWidth / 2`. */
  cornerRadiusPx: number;
  shape: MaskShape;
  /** New element bounds in scene units. */
  element: Rect;
};

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

/**
 * Flips (`element.scale`) are intentionally NOT baked: Excalidraw mirrors the
 * whole drawn box, and both shapes are centred + symmetric, so the selected
 * region and the mask are flip-invariant. The output keeps the element's
 * `scale`, which stock Excalidraw renders identically.
 */
export function planMask(opts: {
  params: MaskParams;
  element: Rect;
  crop: CropLike | null;
  naturalWidth: number;
  naturalHeight: number;
  isVector?: boolean;
}): MaskPlan {
  const { params, element: el } = opts;
  if (!(el.width > 0) || !(el.height > 0)) throw new Error("mask: element has no size");
  // SVGs without intrinsic size decode as 0×0; treat the display box as the source.
  const nw = opts.naturalWidth > 0 ? opts.naturalWidth : (opts.crop?.naturalWidth ?? el.width);
  const nh = opts.naturalHeight > 0 ? opts.naturalHeight : (opts.crop?.naturalHeight ?? el.height);
  const src = visibleSourceRect(opts.crop, nw, nh);
  const dx = src.width / el.width;
  const dy = src.height / el.height;
  const density = Math.max(dx, dy, opts.isVector ? VECTOR_DENSITY : 0);

  if (params.shape === "circle") {
    const side = Math.min(el.width, el.height);
    const sw = side * dx;
    const sh = side * dy;
    const n = clampPx(side * density);
    return {
      shape: "circle",
      sourceRect: {
        x: src.x + (src.width - sw) / 2,
        y: src.y + (src.height - sh) / 2,
        width: sw,
        height: sh,
      },
      outWidth: n,
      outHeight: n,
      cornerRadiusPx: n / 2,
      element: {
        x: el.x + (el.width - side) / 2,
        y: el.y + (el.height - side) / 2,
        width: side,
        height: side,
      },
    };
  }

  let w = el.width * density;
  let h = el.height * density;
  const longest = Math.max(w, h);
  if (longest > MAX_OUTPUT_PX) {
    w = (w * MAX_OUTPUT_PX) / longest;
    h = (h * MAX_OUTPUT_PX) / longest;
  }
  const outWidth = clampPx(w);
  const outHeight = clampPx(h);
  const pct = params.radius ?? DEFAULT_RADIUS;
  return {
    shape: "roundedRect",
    sourceRect: src,
    outWidth,
    outHeight,
    cornerRadiusPx: Math.min(
      (pct / 100) * Math.min(outWidth, outHeight),
      outWidth / 2,
      outHeight / 2,
    ),
    element: { x: el.x, y: el.y, width: el.width, height: el.height },
  };
}

function clampPx(v: number): number {
  return Math.max(1, Math.min(MAX_OUTPUT_PX, Math.round(v)));
}

/**
 * Bounds to restore on removal. Keeps the element's current centre (so a moved
 * mask restores in place) and scales the original size by any resize applied
 * since masking. With no edits this returns the original bounds exactly
 * (up to float rounding).
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

/**
 * Deterministic output file id: identical source file + visible region +
 * params + output size → identical id, so re-applying never bloats `files`.
 * 40 hex chars to match the shape of Excalidraw's own (SHA-1) file ids.
 */
export function maskFileId(sourceFileId: string, plan: MaskPlan, version: number): string {
  const r = plan.sourceRect;
  const key = JSON.stringify([
    "mask",
    version,
    sourceFileId,
    plan.shape,
    round4(r.x),
    round4(r.y),
    round4(r.width),
    round4(r.height),
    plan.outWidth,
    plan.outHeight,
    round4(plan.cornerRadiusPx),
  ]);
  return (hash53(key, 1) + hash53(key, 2) + hash53(key, 3)).slice(0, 40);
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
