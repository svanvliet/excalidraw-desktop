/**
 * Mask extension: masks an image element to a circle or rounded rectangle. A shape stage of the
 * image pipeline (../stack.ts): it changes the plan's bounds / visible source / outline, and the
 * pipeline clips the output to that outline, baking the mask into the PNG's alpha channel.
 */
import { isLoadedImage } from "../pipeline";
import { STAGE, type DesktopExtension } from "../types";
import { maskParamsSchema, maskStep, normalizeMaskParams, type MaskParams } from "./geometry";

export type { MaskParams } from "./geometry";

export const maskExtension: DesktopExtension<MaskParams> = {
  id: "mask",
  version: 1,
  stage: STAGE.shape,
  title: "Mask",
  description: "Mask an image to a circle or rounded rectangle",
  paramsSchema: maskParamsSchema,
  presets: [
    { id: "circle", label: "Circle", params: { shape: "circle" } },
    {
      id: "roundedRect",
      label: "Rounded rectangle",
      params: { shape: "roundedRect", radius: 15 },
    },
  ],
  appliesTo: isLoadedImage,
  normalizeParams: normalizeMaskParams,
  plan: maskStep,
};
