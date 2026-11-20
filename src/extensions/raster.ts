/**
 * Webview-only raster step of the image pipeline. Kept separate from the pure geometry so tests can
 * mock this module (jsdom has no canvas).
 */
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { outlinePath, type ImagePlan } from "./pipeline";
import type { RenderTarget } from "./types";

/** A chain link ready to draw: the extension's `render` bound to its params. */
export type RenderStep = (ctx: RenderTarget, plan: ImagePlan) => void;

export type LoadedSource = {
  /** 0 when unknown (e.g. an SVG with only a viewBox); geometry falls back. */
  naturalWidth: number;
  naturalHeight: number;
  /**
   * Draws `plan.sourceRect` into the output size, runs `steps` in order, then clips everything to
   * `plan.outline`. Returns a PNG data URL.
   */
  render(plan: ImagePlan, steps: readonly RenderStep[]): Promise<string>;
};

export async function loadSource(file: BinaryFileData): Promise<LoadedSource> {
  // SVG files were sanitized on insert; an <img> rasterizes them at the requested draw size, so
  // vectors stay crisp. Animated GIF/WebP draw their current (first) frame only.
  const img = new Image();
  img.decoding = "async";
  img.src = file.dataURL;
  try {
    await img.decode();
  } catch {
    throw new Error("could not decode the source image");
  }
  return {
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    render: async (plan, steps) => renderPlan(img, plan, steps),
  };
}

function renderPlan(img: HTMLImageElement, plan: ImagePlan, steps: readonly RenderStep[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = plan.outWidth;
  canvas.height = plan.outHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const r = plan.sourceRect;
  ctx.drawImage(img, r.x, r.y, r.width, r.height, 0, 0, plan.outWidth, plan.outHeight);

  for (const step of steps) {
    ctx.save();
    step(ctx, plan);
    ctx.restore();
  }

  // Keep only pixels inside the outline; the anti-aliased fill gives a soft edge. Doing this last
  // means decorations that trace the outline share exactly the same outer edge.
  if (plan.outline.kind !== "rect") {
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    outlinePath(ctx, plan);
    ctx.fillStyle = "#000";
    ctx.fill();
  }
  return canvas.toDataURL("image/png");
}
