/** The image panel's section API: see IMAGE_SECTIONS in ./registry. */
import type { ComponentType } from "react";
import type { ExtensionGroup } from "../../extensions/groups";
import type { ExtensionAction } from "../../extensions/runner";

/** What an image section gets. Busy / error state is shared by all image sections. */
export interface ImageSectionProps {
  /** The selection's extension groups, by extension id (only this section's extensions). */
  groups: ReadonlyMap<string, ExtensionGroup>;
  /** Every selected element is an image. */
  onlyImages: boolean;
  /** Legend for a mixed selection: "Stroke" becomes "Image stroke". */
  label(name: string): string;
  /** An extension run is in flight: disable the controls. */
  busy: boolean;
  /** Runs an extension action on the group's images: one undo step; errors show below. */
  run(group: ExtensionGroup, action: ExtensionAction): void;
}

/**
 * One section of the image panel, shown when the selection has a group for any of
 * `extensions` (see extensionGroups). Display order is array order.
 */
export interface ImageSection {
  id: string;
  extensions: readonly string[];
  Component: ComponentType<ImageSectionProps>;
}

export interface ImageView {
  groups: ExtensionGroup[];
  onlyImages: boolean;
}
