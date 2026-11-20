/**
 * Test-only decoration extension (paints a tint): exercises the stack without the mask's geometry.
 */
import { isLoadedImage } from "./pipeline";
import { STAGE, type DesktopExtension } from "./types";

export interface StubParams {
  color: "red" | "blue";
}

export const stubExtension: DesktopExtension<StubParams> = {
  id: "stub",
  version: 1,
  stage: STAGE.decoration,
  title: "Stub",
  appliesTo: isLoadedImage,
  paramsSchema: {
    type: "object",
    properties: { color: { type: "string", enum: ["red", "blue"] } },
    required: ["color"],
    additionalProperties: false,
  },
  presets: [
    { id: "red", label: "Red", params: { color: "red" } },
    { id: "blue", label: "Blue", params: { color: "blue" } },
  ],
  normalizeParams(input) {
    const color = (input as { color?: unknown } | null)?.color;
    if (color !== "red" && color !== "blue") throw new Error("stub: bad color");
    return { color };
  },
  render(ctx, _plan, p) {
    ctx.fillStyle = p.color;
  },
};
