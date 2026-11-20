/**
 * Webview-only raster step for the mask extension. Kept separate from the
 * pure geometry so tests can mock this module (jsdom has no canvas).
 */
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { MaskPlan } from "./geometry";

export type LoadedSource = {
  /** 0 when unknown (e.g. an SVG with only a viewBox); geometry falls back. */
  naturalWidth: number;
  naturalHeight: number;
  /** Draws `plan.sourceRect` into the output size and bakes the alpha mask. Returns a PNG data URL. */
  render(plan: MaskPlan): Promise<string>;
};

export async function loadSource(file: BinaryFileData): Promise<LoadedSource> {
  // SVG files were sanitized on insert; an <img> rasterizes them at the
  // requested draw size, so vectors stay crisp. Animated GIF/WebP draw their
  // current (first) frame only — acceptable for a static mask.
  const img = new Image();
  img.decoding = "async";
  img.src = file.dataURL;
  try {
    await img.decode();
  } catch {
    throw new Error("mask: could not decode the source image");
  }
  return {
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    render: async (plan) => renderMask(img, plan),
  };
}

function renderMask(img: HTMLImageElement, plan: MaskPlan): string {
  const canvas = document.createElement("canvas");
  canvas.width = plan.outWidth;
  canvas.height = plan.outHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("mask: 2D canvas unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const r = plan.sourceRect;
  ctx.drawImage(img, r.x, r.y, r.width, r.height, 0, 0, plan.outWidth, plan.outHeight);

  // Keep only pixels inside the shape; the path fill is anti-aliased, giving a soft edge.
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  if (plan.shape === "circle") {
    ctx.ellipse(
      plan.outWidth / 2,
      plan.outHeight / 2,
      plan.outWidth / 2,
      plan.outHeight / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else {
    roundedRectPath(ctx, plan.outWidth, plan.outHeight, plan.cornerRadiusPx);
  }
  ctx.fillStyle = "#000";
  ctx.fill();
  return canvas.toDataURL("image/png");
}

// Manual path rather than ctx.roundRect for older WebKit (macOS 12 WKWebView).
function roundedRectPath(ctx: CanvasRenderingContext2D, w: number, h: number, r: number) {
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
