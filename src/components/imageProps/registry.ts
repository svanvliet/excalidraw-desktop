import { EffectsSection } from "./EffectsSection";
import { MaskSection } from "./MaskSection";
import { StrokeSection } from "./StrokeSection";
import type { ImageSection } from "./types";

/**
 * The image panel's sections, in display order. To add one, append an entry here (keep each
 * section's component in its own module if it is large).
 */
export const IMAGE_SECTIONS: ImageSection[] = [
  { id: "stroke", extensions: ["border"], Component: StrokeSection },
  { id: "mask", extensions: ["mask"], Component: MaskSection },
  { id: "effects", extensions: ["grayscale", "tint", "shadow"], Component: EffectsSection },
];
