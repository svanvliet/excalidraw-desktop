/**
 * Test double for ./raster (jsdom has no canvas): `vi.mock(".../raster", () => import(".../testRaster"))`.
 * Source size comes from a `WxH` in the data URL (default 100×100). `render` runs the steps against
 * a recording context and returns a deterministic data URL describing the plan.
 */
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ImagePlan } from "./pipeline";
import type { LoadedSource, RenderStep } from "./raster";
import type { RenderTarget } from "./types";

export type { LoadedSource, RenderStep } from "./raster";

export interface RenderCall {
  source: string;
  plan: ImagePlan;
  /** Canvas calls / property writes made by the steps, e.g. `stroke()` or `lineWidth=8`. */
  ops: string[];
}

export const renders: RenderCall[] = [];

export function recordingContext(ops: string[]): RenderTarget {
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, key) =>
      (...args: unknown[]) => {
        ops.push(`${String(key)}(${args.map((a) => (typeof a === "number" ? +a.toFixed(3) : a)).join(",")})`);
      },
    set: (_t, key, value) => {
      ops.push(`${String(key)}=${value}`);
      return true;
    },
  }) as unknown as RenderTarget;
}

export async function loadSource(file: BinaryFileData): Promise<LoadedSource> {
  const m = /(\d+)x(\d+)/.exec(file.dataURL);
  return {
    naturalWidth: m ? Number(m[1]) : 100,
    naturalHeight: m ? Number(m[2]) : 100,
    async render(plan: ImagePlan, steps: readonly RenderStep[]) {
      const ops: string[] = [];
      const ctx = recordingContext(ops);
      for (const step of steps) step(ctx, plan);
      renders.push({ source: file.id, plan, ops });
      return `data:image/png;base64,${plan.outline.kind}-${plan.outWidth}x${plan.outHeight}-${steps.length}`;
    },
  };
}
