/**
 * Image controls in Excalidraw's own properties panel (docs/extensions.md § "UI surface").
 *
 * Excalidraw's panel hides stroke controls for images, so while images are selected this panel
 * section (hosted by PropertiesPanelHost, "top" slot, right where Stroke sits for shapes) shows
 * native-looking image sections: stroke colour / width / style / sloppiness for the border
 * extension, and the mask shape. Other extensions add theirs to IMAGE_SECTIONS.
 *
 * Every click runs `runExtension`: one undo step, the same path the agent tools use.
 */
import { extensionGroups } from "../../extensions/groups";
import type { PanelSection } from "../propertiesPanel/panel";
import { ImageSections } from "./ImageSections";
import { IMAGE_SECTIONS } from "./registry";
import type { ImageView } from "./types";

export const imagePanelSection: PanelSection<ImageView> = {
  id: "image",
  slot: "top",
  testId: "image-props",
  view({ selected }) {
    const wanted = new Set(IMAGE_SECTIONS.flatMap((s) => s.extensions));
    const groups = extensionGroups(selected).filter((g) => wanted.has(g.id));
    if (!groups.length) return null;
    return { groups, onlyImages: selected.every((el) => el.type === "image") };
  },
  Component: ImageSections,
};
