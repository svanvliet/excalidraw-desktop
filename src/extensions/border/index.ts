/**
 * Border extension: strokes the image's outline — the full rectangle, or whatever shape an earlier
 * stage (mask) produced. A decoration stage: it never changes bounds; the stroke is drawn centred
 * on the outline at twice the width and the pipeline's final outline clip removes the outer half,
 * so the border sits inside the edge and shares the mask's exact anti-aliased outer edge.
 *
 * Stock Excalidraw 0.18 ignores `strokeColor` / `strokeWidth` on images, hence a baked border.
 */
import rough from "roughjs";
import type { Options as RoughOptions } from "roughjs/bin/core";
import { isLoadedImage, outlinePath, outputScale, type ImagePlan } from "../pipeline";
import { STAGE, type DesktopExtension, type RenderTarget } from "../types";

export const BORDER_STYLES = ["solid", "dashed", "dotted"] as const;
export type BorderStyle = (typeof BORDER_STYLES)[number];
/** Excalidraw's sloppiness levels: architect, artist, cartoonist. */
export const BORDER_ROUGHNESS = [0, 1, 2] as const;
export type BorderRoughness = (typeof BORDER_ROUGHNESS)[number];
/** Excalidraw's stroke widths: thin, bold, extra bold. */
export const BORDER_WIDTHS = { thin: 1, bold: 2, extraBold: 4 } as const;

export type BorderParams = {
  /** Scene units at the image's size when applied (scales with later resizes). */
  width: number;
  /** `#rrggbb`. */
  color: string;
  /** 0–100 %. */
  opacity: number;
  style: BorderStyle;
  /** 0 architect (crisp), 1 artist, 2 cartoonist — drawn with roughjs like native shapes. */
  roughness: BorderRoughness;
};

export const DEFAULT_BORDER_COLOR = "#868e96";
const DEFAULTS: BorderParams = {
  width: BORDER_WIDTHS.bold,
  color: DEFAULT_BORDER_COLOR,
  opacity: 100,
  style: "solid",
  roughness: 0,
};

export const borderParamsSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    width: {
      type: "number",
      minimum: 0.5,
      maximum: 100,
      default: DEFAULTS.width,
      description:
        "Stroke width in scene units, drawn inside the image edge (Excalidraw: thin 1, bold 2, extra bold 4)",
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
    style: {
      type: "string",
      enum: [...BORDER_STYLES],
      default: DEFAULTS.style,
      description: "Stroke style",
    },
    roughness: {
      type: "number",
      enum: [...BORDER_ROUGHNESS],
      default: DEFAULTS.roughness,
      description: "Sloppiness: 0 architect, 1 artist, 2 cartoonist",
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
  if (p.style !== undefined && !BORDER_STYLES.includes(p.style as BorderStyle)) {
    fail(`style must be one of ${BORDER_STYLES.join(", ")}`);
  }
  if (p.roughness !== undefined && !BORDER_ROUGHNESS.includes(p.roughness as BorderRoughness)) {
    fail("roughness must be 0, 1 or 2");
  }
  return {
    width: num(p.width, "width", 0.5, 100, DEFAULTS.width),
    color,
    opacity: num(p.opacity, "opacity", 0, 100, DEFAULTS.opacity),
    style: (p.style as BorderStyle | undefined) ?? DEFAULTS.style,
    roughness: (p.roughness as BorderRoughness | undefined) ?? DEFAULTS.roughness,
  };
}

/** v1 borders were crisp solid strokes; keep them rendering exactly as before. */
export function migrateBorderParams(
  params: Record<string, unknown>,
  fromVersion: number,
): Record<string, unknown> {
  return fromVersion < 2 ? { style: "solid", roughness: 0, ...params } : params;
}

/** Excalidraw's dash arrays (scene units) for a stroke width. */
function dashArray(style: BorderStyle, sw: number): number[] | undefined {
  if (style === "dashed") return [8, 8 + sw];
  if (style === "dotted") return [1.5, 6 + sw];
  return undefined;
}

/** Stable 31-bit seed from the render inputs, so re-renders produce identical pixels. */
function seedFor(plan: ImagePlan, p: BorderParams): number {
  const key = JSON.stringify([plan.outWidth, plan.outHeight, plan.outline, p]);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 1 || 1;
}

/** The outline (in scene units) shrunk by `d`, as an SVG path for roughjs. */
function insetPath(plan: ImagePlan, W: number, H: number, s: number, d: number): string {
  const [x0, y0, w, h] = [d, d, Math.max(0, W - 2 * d), Math.max(0, H - 2 * d)];
  const o = plan.outline;
  const r = o.kind === "roundedRect" ? Math.max(0, Math.min(o.radiusPx / s - d, w / 2, h / 2)) : 0;
  const [x1, y1] = [x0 + w, y0 + h];
  if (r === 0) return `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`;
  return (
    `M ${x0 + r} ${y0} L ${x1 - r} ${y0} Q ${x1} ${y0}, ${x1} ${y0 + r} ` +
    `L ${x1} ${y1 - r} Q ${x1} ${y1}, ${x1 - r} ${y1} L ${x0 + r} ${y1} ` +
    `Q ${x0} ${y1}, ${x0} ${y1 - r} L ${x0} ${y0 + r} Q ${x0} ${y0}, ${x0 + r} ${y0}`
  );
}

const generator = rough.generator();

/** Sketchy / dashed stroke along the inset outline, drawn in scene units like a native shape. */
function renderRough(ctx: RenderTarget, plan: ImagePlan, p: BorderParams, sw: number) {
  const s = outputScale(plan);
  const [W, H] = [plan.outWidth / s, plan.outHeight / s];
  // Excalidraw tones roughness down on small shapes (adjustRoughness).
  const roughness =
    Math.min(W, H) >= 20 && Math.max(W, H) >= 50
      ? p.roughness
      : Math.min(p.roughness / (Math.max(W, H) < 10 ? 3 : 2), 2.5);
  const width = p.style === "solid" ? sw : sw + 0.5;
  // Keep the stroke (and most of its wobble) inside the edge; the outline clip trims the rest.
  const d = Math.min(width / 2 + roughness, Math.min(W, H) / 2);
  const options: RoughOptions = {
    seed: seedFor(plan, p),
    roughness,
    stroke: p.color,
    strokeWidth: width,
    strokeLineDash: dashArray(p.style, sw),
    disableMultiStroke: p.style !== "solid",
    preserveVertices: roughness < 2,
  };
  const drawable =
    plan.outline.kind === "ellipse"
      ? generator.ellipse(W / 2, H / 2, W - 2 * d, H - 2 * d, { ...options, curveFitting: 1 })
      : generator.path(insetPath(plan, W, H, s, d), options);
  ctx.scale(s, s);
  ctx.strokeStyle = p.color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (options.strokeLineDash) ctx.setLineDash(options.strokeLineDash);
  for (const set of drawable.sets) {
    if (set.type !== "path") continue;
    ctx.beginPath();
    for (const { op, data } of set.ops) {
      if (op === "move") ctx.moveTo(data[0]!, data[1]!);
      else if (op === "lineTo") ctx.lineTo(data[0]!, data[1]!);
      else ctx.bezierCurveTo(data[0]!, data[1]!, data[2]!, data[3]!, data[4]!, data[5]!);
    }
    ctx.stroke();
  }
}

export const borderExtension: DesktopExtension<BorderParams> = {
  id: "border",
  version: 2,
  stage: STAGE.decoration,
  title: "Border",
  description:
    "Draw a border inside the image edge that follows any mask shape (solid, dashed or dotted; sketchy like native shapes)",
  paramsSchema: borderParamsSchema,
  presets: [
    { id: "thin", label: "Thin", params: { width: BORDER_WIDTHS.thin } },
    { id: "bold", label: "Bold", params: { width: BORDER_WIDTHS.bold } },
    { id: "extraBold", label: "Extra bold", params: { width: BORDER_WIDTHS.extraBold } },
  ],
  defaultPreset: "bold",
  choices: {
    param: "color",
    label: "Colour",
    options: [
      { value: "#1e1e1e", label: "Black", swatch: "#1e1e1e" },
      { value: "#e03131", label: "Red", swatch: "#e03131" },
      { value: "#2f9e44", label: "Green", swatch: "#2f9e44" },
      { value: "#1971c2", label: "Blue", swatch: "#1971c2" },
      { value: "#f08c00", label: "Orange", swatch: "#f08c00" },
    ],
  },
  appliesTo: isLoadedImage,
  normalizeParams: normalizeBorderParams,
  migrateParams: migrateBorderParams,
  render(ctx, plan, p) {
    const s = outputScale(plan);
    const sw = Math.min(p.width, Math.min(plan.outWidth, plan.outHeight) / 2 / s);
    if (!(sw > 0) || p.opacity <= 0) return;
    ctx.globalAlpha = p.opacity / 100;
    if (p.style !== "solid" || p.roughness > 0) {
      renderRough(ctx, plan, p, sw);
      return;
    }
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2 * sw * s;
    ctx.lineJoin = "miter";
    ctx.beginPath();
    outlinePath(ctx, plan);
    ctx.stroke();
  },
};
