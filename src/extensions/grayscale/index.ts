/**
 * Grayscale extension: desaturates an image by `amount` (like CSS `grayscale()`). A colour stage:
 * it runs on the source pixels before any mask or border, so a coloured border stays coloured.
 */
import { isLoadedImage } from "../pipeline";
import { luma, numParam } from "../pixels";
import { STAGE, type DesktopExtension, type PixelBuffer } from "../types";

export type GrayscaleParams = {
  /** 0–100 %: 0 leaves the image alone, 100 is fully gray. */
  amount: number;
};

const DEFAULT_AMOUNT = 100;

function fail(msg: string): never {
  throw new Error(`grayscale: ${msg}`);
}

export const grayscaleParamsSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    amount: {
      type: "number",
      minimum: 0,
      maximum: 100,
      default: DEFAULT_AMOUNT,
      description: "How gray, in % (100 = fully grayscale)",
    },
  },
};

export function normalizeGrayscaleParams(input: unknown): GrayscaleParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("params must be an object");
  const p = input as Record<string, unknown>;
  for (const k of Object.keys(p)) if (k !== "amount") fail(`unknown param "${k}"`);
  return { amount: numParam(p.amount, "amount", 0, 100, DEFAULT_AMOUNT, fail) };
}

/** Mixes every pixel towards its Rec. 709 luma; alpha is kept. */
export function grayscalePixels(img: PixelBuffer, p: GrayscaleParams): void {
  const a = p.amount / 100;
  if (a <= 0) return;
  const d = img.data;
  for (let o = 0; o < d.length; o += 4) {
    const [r, g, b] = [d[o]!, d[o + 1]!, d[o + 2]!];
    const l = luma(r, g, b);
    d[o] = Math.round(r + (l - r) * a);
    d[o + 1] = Math.round(g + (l - g) * a);
    d[o + 2] = Math.round(b + (l - b) * a);
  }
}

export const grayscaleExtension: DesktopExtension<GrayscaleParams> = {
  id: "grayscale",
  version: 1,
  stage: STAGE.color,
  title: "Grayscale",
  description: "Desaturate an image by an amount from 0 to 100%",
  paramsSchema: grayscaleParamsSchema,
  presets: [{ id: "grayscale", label: "Grayscale", params: { amount: 100 } }],
  defaultPreset: "grayscale",
  appliesTo: isLoadedImage,
  normalizeParams: normalizeGrayscaleParams,
  pixels: (img, _plan, p) => grayscalePixels(img, p),
};
