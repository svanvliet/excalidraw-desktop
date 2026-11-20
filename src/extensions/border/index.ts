/**
 * Border extension: strokes the image's outline — the full rectangle, or whatever shape an earlier
 * stage (mask) produced. A decoration stage: it never changes bounds; the stroke is drawn centred
 * on the outline at twice the width and the pipeline's final outline clip removes the outer half,
 * so the border sits inside the edge and shares the mask's exact anti-aliased outer edge.
 *
 * Stock Excalidraw 0.18 ignores `strokeColor` / `strokeWidth` on images, hence a baked border.
 */
import { isLoadedImage, outlinePath, outputScale } from "../pipeline";
import { STAGE, type DesktopExtension } from "../types";

export type BorderParams = {
  /** Scene units at the image's size when applied (scales with later resizes). */
  width: number;
  /** `#rrggbb`. */
  color: string;
  /** 0–100 %. */
  opacity: number;
};

export const DEFAULT_BORDER_COLOR = "#868e96";
const DEFAULTS: BorderParams = { width: 4, color: DEFAULT_BORDER_COLOR, opacity: 100 };

export const borderParamsSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    width: {
      type: "number",
      minimum: 0.5,
      maximum: 100,
      default: DEFAULTS.width,
      description: "Stroke width in scene units, drawn inside the image edge",
    },
    color: {
      type: "string",
      pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$",
      default: DEFAULTS.color,
      description: "Hex colour, e.g. #1e1e1e",
    },
    opacity: {
      type: "number",
      minimum: 0,
      maximum: 100,
      default: DEFAULTS.opacity,
      description: "Stroke opacity in %",
    },
  },
};

function fail(msg: string): never {
  throw new Error(`border: ${msg}`);
}

function num(v: unknown, name: string, min: number, max: number, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    fail(`${name} must be a number between ${min} and ${max}`);
  }
  return v;
}

/** Validates unknown input and fills defaults. Throws a readable Error on bad input. */
export function normalizeBorderParams(input: unknown): BorderParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("params must be an object");
  const p = input as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!(k in DEFAULTS)) fail(`unknown param "${k}"`);
  }
  let color = DEFAULTS.color;
  if (p.color !== undefined) {
    const m = typeof p.color === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(p.color);
    if (!m) fail("color must be a hex colour like #1e1e1e");
    const hex = m[1].toLowerCase();
    color = `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
  }
  return {
    width: num(p.width, "width", 0.5, 100, DEFAULTS.width),
    color,
    opacity: num(p.opacity, "opacity", 0, 100, DEFAULTS.opacity),
  };
}

export const borderExtension: DesktopExtension<BorderParams> = {
  id: "border",
  version: 1,
  stage: STAGE.decoration,
  title: "Border",
  description: "Draw a border inside the image edge that follows any mask shape",
  paramsSchema: borderParamsSchema,
  presets: [
    { id: "thin", label: "Thin", params: { width: 2 } },
    { id: "medium", label: "Medium", params: { width: 4 } },
    { id: "thick", label: "Thick", params: { width: 8 } },
  ],
  defaultPreset: "medium",
  choices: {
    param: "color",
    label: "Colour",
    options: [
      { value: "#868e96", label: "Gray", swatch: "#868e96" },
      { value: "#1e1e1e", label: "Black", swatch: "#1e1e1e" },
      { value: "#ffffff", label: "White", swatch: "#ffffff" },
      { value: "#1971c2", label: "Blue", swatch: "#1971c2" },
      { value: "#e03131", label: "Red", swatch: "#e03131" },
    ],
  },
  appliesTo: isLoadedImage,
  normalizeParams: normalizeBorderParams,
  render(ctx, plan, p) {
    const w = Math.min(p.width * outputScale(plan), Math.min(plan.outWidth, plan.outHeight) / 2);
    if (!(w > 0) || p.opacity <= 0) return;
    ctx.globalAlpha = p.opacity / 100;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2 * w;
    ctx.lineJoin = "miter";
    ctx.beginPath();
    outlinePath(ctx, plan);
    ctx.stroke();
  },
};
