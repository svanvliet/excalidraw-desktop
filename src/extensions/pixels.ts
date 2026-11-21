/**
 * Pure pixel maths shared by the colour and effect stages. Works on unpremultiplied RGBA buffers
 * (`ImageData`), so it needs no canvas filters (WKWebView has no `ctx.filter`) and is unit-tested
 * in jsdom.
 */
import type { PixelBuffer } from "./types";

/** `#rgb` / `#rrggbb` → lower-case `#rrggbb`, or null. */
export function normalizeHex(input: unknown): string | null {
  const m = typeof input === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input);
  if (!m) return null;
  const hex = m[1]!.toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
}

/** `#rrggbb` → [r, g, b]. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Validated number param with a default; `fail` throws the extension's readable error. */
export function numParam(
  v: unknown,
  name: string,
  min: number,
  max: number,
  dflt: number,
  fail: (msg: string) => never,
): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    fail(`${name} must be a number between ${min} and ${max}`);
  }
  return v;
}

/** Rec. 709 luma, as CSS `grayscale()` uses. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Box radius per pass so three box blurs approximate a Gaussian with σ = `blurPx` / 2 (the CSS
 * blur radius convention). The blurred alpha reaches 3 × radius beyond the shape.
 */
export function boxRadius(blurPx: number): number {
  if (!(blurPx > 0)) return 0;
  // Three passes of width w have σ² = 3(w² − 1)/12, so w = √(1 + 4σ²) = √(1 + blurPx²).
  return Math.max(0, Math.round((Math.sqrt(1 + blurPx * blurPx) - 1) / 2));
}

/** One horizontal + vertical box pass of radius `r` over a w×h float plane (zero outside). */
function boxPass(src: Float32Array, tmp: Float32Array, w: number, h: number, r: number) {
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x < Math.min(r, w); x++) acc += src[row + x]!;
    for (let x = 0; x < w; x++) {
      if (x + r < w) acc += src[row + x + r]!;
      tmp[row + x] = acc / n;
      if (x - r >= 0) acc -= src[row + x - r]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y < Math.min(r, h); y++) acc += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      if (y + r < h) acc += tmp[(y + r) * w + x]!;
      src[y * w + x] = acc / n;
      if (y - r >= 0) acc -= tmp[(y - r) * w + x]!;
    }
  }
}

/** Gaussian-like blur (three box passes of radius `r`) of a w×h plane, in place. */
export function blurPlane(plane: Float32Array, w: number, h: number, r: number): void {
  if (r <= 0) return;
  const tmp = new Float32Array(plane.length);
  for (let i = 0; i < 3; i++) boxPass(plane, tmp, w, h, r);
}

/** Composites `[r, g, b]` with per-pixel alpha `alpha[i]` (0–1) over `out`, source-over. */
export function compositeOver(
  out: PixelBuffer,
  rgb: readonly [number, number, number],
  alpha: Float32Array,
): void {
  const d = out.data;
  for (let i = 0; i < alpha.length; i++) {
    const sa = alpha[i]!;
    if (sa <= 0) continue;
    const o = i * 4;
    const da = d[o + 3]! / 255;
    const a = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) {
      d[o + c] = Math.round((rgb[c]! * sa + d[o + c]! * da * (1 - sa)) / a);
    }
    d[o + 3] = Math.round(a * 255);
  }
}
