/**
 * Tint extension: recolours an image towards one colour by `strength`. Each pixel's luma is
 * mapped onto a black → colour → white ramp (so shading and highlights survive even at 100%),
 * then mixed with the original. A colour stage, after grayscale and before mask / border.
 */
import { isLoadedImage } from "../pipeline";
import { hexToRgb, luma, normalizeHex, numParam } from "../pixels";
import { STAGE, type DesktopExtension, type PixelBuffer } from "../types";

export type TintParams = {
  /** `#rrggbb`. */
  color: string;
  /** 0–100 %. */
  strength: number;
};

export const DEFAULT_TINT_COLOR = "#1971c2";
const DEFAULTS: TintParams = { color: DEFAULT_TINT_COLOR, strength: 50 };

function fail(msg: string): never {
  throw new Error(`tint: ${msg}`);
}

export const tintParamsSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    color: {
      type: "string",
      pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$",
      default: DEFAULTS.color,
      description: "Hex colour, e.g. #1971c2",
    },
    strength: {
      type: "number",
      minimum: 0,
      maximum: 100,
      default: DEFAULTS.strength,
      description: "Tint strength in % (100 = fully recoloured, keeping light and shade)",
    },
  },
};

export function normalizeTintParams(input: unknown): TintParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("params must be an object");
  const p = input as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!(k in DEFAULTS)) fail(`unknown param "${k}"`);
  let color = DEFAULTS.color;
  if (p.color !== undefined) {
    color = normalizeHex(p.color) ?? fail("color must be a hex colour like #1971c2");
  }
  return { color, strength: numParam(p.strength, "strength", 0, 100, DEFAULTS.strength, fail) };
}

export function tintPixels(img: PixelBuffer, p: TintParams): void {
  const s = p.strength / 100;
  if (s <= 0) return;
  const rgb = hexToRgb(p.color);
  const d = img.data;
  for (let o = 0; o < d.length; o += 4) {
    const l = luma(d[o]!, d[o + 1]!, d[o + 2]!) / 255;
    for (let c = 0; c < 3; c++) {
      const tc = rgb[c]!;
      const ramp = l < 0.5 ? tc * 2 * l : tc + (255 - tc) * (2 * l - 1);
      d[o + c] = Math.round(d[o + c]! + (ramp - d[o + c]!) * s);
    }
  }
}

export const tintExtension: DesktopExtension<TintParams> = {
  id: "tint",
  version: 1,
  // After grayscale (same family), so gray + tint gives a duotone.
  stage: STAGE.color + 10,
  title: "Tint",
  description: "Tint an image towards a colour, keeping its light and shade",
  paramsSchema: tintParamsSchema,
  presets: [{ id: "tint", label: "Tint", params: {} }],
  defaultPreset: "tint",
  appliesTo: isLoadedImage,
  normalizeParams: normalizeTintParams,
  pixels: (img, _plan, p) => tintPixels(img, p),
};
