/**
 * Webview-only raster step of the image pipeline. Kept separate from the pure geometry so tests can
 * mock this module (jsdom has no canvas).
 */
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { outlinePath, padOf, paddedSize, type ImagePlan } from "./pipeline";
import type { PixelBuffer, RenderTarget } from "./types";

/** A chain link ready to draw: the extension's `render` / `pixels` / `renderBehind` bound to its params. */
export type RenderStep =
  | { kind: "draw"; run(ctx: RenderTarget, plan: ImagePlan): void }
  | { kind: "pixels"; run(img: PixelBuffer, plan: ImagePlan): void }
  | { kind: "behind"; run(out: PixelBuffer, content: PixelBuffer, plan: ImagePlan): void };

export type LoadedSource = {
  /** 0 when unknown (e.g. an SVG with only a viewBox); geometry falls back. */
  naturalWidth: number;
  naturalHeight: number;
  /**
   * Draws `plan.sourceRect` into the output size, runs the draw / pixel `steps` in order, clips
   * everything to `plan.outline`, then (for a `plan.pad`) paints the behind steps on a larger
   * bitmap under the content. Returns a PNG data URL.
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
    if (step.kind === "draw") {
      ctx.save();
      step.run(ctx, plan);
      ctx.restore();
    } else if (step.kind === "pixels") {
      const img = ctx.getImageData(0, 0, plan.outWidth, plan.outHeight);
      step.run(img, plan);
      ctx.putImageData(img, 0, 0);
    }
  }

  // Keep only pixels inside the outline; the anti-aliased fill gives a soft edge. Doing this last
  // means decorations that trace the outline share exactly the same outer edge.
  if (plan.outline.kind !== "rect") {
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    outlinePath(ctx, plan);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
  const behind = steps.filter((s) => s.kind === "behind");
  if (!plan.pad && !behind.length) return canvas.toDataURL("image/png");

  // Effects outside the image: a larger bitmap, effects first, the content on top at the margin.
  const pad = padOf(plan);
  const size = paddedSize(plan);
  const outer = document.createElement("canvas");
  outer.width = size.width;
  outer.height = size.height;
  const octx = outer.getContext("2d");
  if (!octx) throw new Error("2D canvas unavailable");
  if (behind.length) {
    const content = ctx.getImageData(0, 0, plan.outWidth, plan.outHeight);
    const out = octx.createImageData(size.width, size.height);
    for (const step of behind) step.run(out, content, plan);
    octx.putImageData(out, 0, 0);
  }
  octx.drawImage(canvas, pad.left, pad.top);
  return outer.toDataURL("image/png");
}
