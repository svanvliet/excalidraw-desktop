/**
 * Shadow extension: a drop shadow behind the image's (possibly masked) shape. An effect stage —
 * last in the chain, so it follows any mask and border.
 *
 * The shadow is drawn outside the image, so `plan` asks for a transparent margin (`plan.pad`)
 * just large enough for the offset blur. The pipeline grows the bitmap and the element box by that
 * margin, so the image itself stays exactly where it was; the stack stores the margin as
 * `source.inset` to re-render and to restore the original bounds on remove.
 *
 * The blur is a manual three-pass box blur of the alpha (WKWebView has no `ctx.filter`).
 */
import { isLoadedImage, outputScale, padOf, paddedSize, type ImagePlan } from "../pipeline";
import { blurPlane, boxRadius, compositeOver, hexToRgb, normalizeHex, numParam } from "../pixels";
import { STAGE, type DesktopExtension, type PixelBuffer } from "../types";

export type ShadowParams = {
  /** Scene units at the image's size when applied; positive = right / down. */
  offsetX: number;
  offsetY: number;
  /** Blur radius in scene units (0 = hard edge). */
  blur: number;
  /** `#rrggbb`. */
  color: string;
  /** 0–100 %. */
  opacity: number;
};

export const DEFAULT_SHADOW_COLOR = "#000000";
const DEFAULTS: ShadowParams = {
  offsetX: 6,
  offsetY: 6,
  blur: 8,
  color: DEFAULT_SHADOW_COLOR,
  opacity: 35,
};

function fail(msg: string): never {
  throw new Error(`shadow: ${msg}`);
}

export const shadowParamsSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    offsetX: {
      type: "number",
      minimum: -100,
      maximum: 100,
      default: DEFAULTS.offsetX,
      description: "Horizontal offset in scene units (positive = right)",
    },
    offsetY: {
      type: "number",
      minimum: -100,
      maximum: 100,
      default: DEFAULTS.offsetY,
      description: "Vertical offset in scene units (positive = down)",
    },
    blur: {
      type: "number",
      minimum: 0,
      maximum: 100,
      default: DEFAULTS.blur,
      description: "Blur radius in scene units (0 = hard shadow)",
    },
    color: {
      type: "string",
      pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$",
      default: DEFAULTS.color,
      description: "Hex colour, e.g. #000000",
    },
    opacity: {
      type: "number",
      minimum: 0,
      maximum: 100,
      default: DEFAULTS.opacity,
      description: "Shadow opacity in %",
    },
  },
};

export function normalizeShadowParams(input: unknown): ShadowParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("params must be an object");
  const p = input as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!(k in DEFAULTS)) fail(`unknown param "${k}"`);
  let color = DEFAULTS.color;
  if (p.color !== undefined) {
    color = normalizeHex(p.color) ?? fail("color must be a hex colour like #000000");
  }
  return {
    offsetX: numParam(p.offsetX, "offsetX", -100, 100, DEFAULTS.offsetX, fail),
    offsetY: numParam(p.offsetY, "offsetY", -100, 100, DEFAULTS.offsetY, fail),
    blur: numParam(p.blur, "blur", 0, 100, DEFAULTS.blur, fail),
    color,
    opacity: numParam(p.opacity, "opacity", 0, 100, DEFAULTS.opacity, fail),
  };
}

/** Offset and box radius in output pixels, bitmap orientation (mirrored when flipped). */
export function shadowGeometry(plan: ImagePlan, p: ShadowParams) {
  const s = outputScale(plan);
  const dx = Math.round(p.offsetX * s) * (plan.flip?.x ? -1 : 1);
  const dy = Math.round(p.offsetY * s) * (plan.flip?.y ? -1 : 1);
  const radius = boxRadius(p.blur * s);
  // Three box passes of radius r spread the alpha 3r beyond the shape.
  return { dx, dy, radius, reach: 3 * radius };
}

export function planShadow(plan: ImagePlan, p: ShadowParams): ImagePlan {
  const { dx, dy, reach } = shadowGeometry(plan, p);
  const prev = padOf(plan);
  const pad = {
    left: Math.max(prev.left, reach - dx, 0),
    right: Math.max(prev.right, reach + dx, 0),
    top: Math.max(prev.top, reach - dy, 0),
    bottom: Math.max(prev.bottom, reach + dy, 0),
  };
  if (!plan.pad && !pad.left && !pad.right && !pad.top && !pad.bottom) return plan;
  return { ...plan, pad };
}

/** Paints the shadow into the padded bitmap `out`, given the finished content pixels. */
export function renderShadow(
  out: PixelBuffer,
  content: PixelBuffer,
  plan: ImagePlan,
  p: ShadowParams,
): void {
  const opacity = p.opacity / 100;
  if (opacity <= 0) return;
  const { dx, dy, radius } = shadowGeometry(plan, p);
  const pad = padOf(plan);
  const size = paddedSize(plan);
  const w = out.width;
  const h = out.height;
  if (w !== size.width || h !== size.height) fail("output size does not match the plan");
  const alpha = new Float32Array(w * h);
  const ox = pad.left + dx;
  const oy = pad.top + dy;
  for (let y = 0; y < content.height; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < content.width; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= w) continue;
      alpha[ty * w + tx] = content.data[(y * content.width + x) * 4 + 3]! / 255;
    }
  }
  blurPlane(alpha, w, h, radius);
  for (let i = 0; i < alpha.length; i++) alpha[i] = alpha[i]! * opacity;
  compositeOver(out, hexToRgb(p.color), alpha);
}

export const shadowExtension: DesktopExtension<ShadowParams> = {
  id: "shadow",
  version: 1,
  stage: STAGE.effect,
  title: "Shadow",
  description: "Drop shadow behind the image (follows any mask), drawn outside its edge",
  paramsSchema: shadowParamsSchema,
  presets: [
    { id: "soft", label: "Soft", params: { offsetX: 0, offsetY: 4, blur: 16, opacity: 25 } },
    { id: "drop", label: "Drop", params: {} },
    { id: "hard", label: "Hard", params: { offsetX: 6, offsetY: 6, blur: 0, opacity: 60 } },
  ],
  defaultPreset: "drop",
  appliesTo: isLoadedImage,
  normalizeParams: normalizeShadowParams,
  plan: planShadow,
  renderBehind: renderShadow,
};
