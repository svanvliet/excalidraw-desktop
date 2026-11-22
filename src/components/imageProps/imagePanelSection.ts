/**
 * Image controls in Excalidraw's own properties panel (docs/extensions.md § "UI surface").
 *
 * Excalidraw's panel hides stroke controls for images, so while images are selected this panel
 * section (hosted by PropertiesPanelHost as the "Image" row of the strip at the top) shows
 * native-looking image sections: stroke colour / width / style / sloppiness for the border
 * extension, and the mask shape. Other extensions add theirs to IMAGE_SECTIONS.
 *
 * Every click runs `runExtension`: one undo step, the same path the agent tools use.
 */
import { extensionGroups } from "../../extensions/groups";
import { ImageIcon } from "../icons";
import type { PanelSection } from "../propertiesPanel/panel";
import { ImageSections } from "./ImageSections";
import { IMAGE_SECTIONS } from "./registry";
import type { ImageView } from "./types";

export const imagePanelSection: PanelSection<ImageView> = {
  id: "image",
  slot: "top",
  testId: "image-props",
  title: "Image",
  icon: ImageIcon,
  summary: ({ groups }) =>
    groups
      .filter((g) => g.removable)
      .map((g) => g.title)
      .join(", ") || "No effects",
  view({ selected }) {
    const wanted = new Set(IMAGE_SECTIONS.flatMap((s) => s.extensions));
    const groups = extensionGroups(selected).filter((g) => wanted.has(g.id));
    if (!groups.length) return null;
    return { groups, onlyImages: selected.every((el) => el.type === "image") };
  },
  Component: ImageSections,
};
