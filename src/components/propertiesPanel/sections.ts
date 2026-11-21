/** Every properties-panel section, in display order within each slot (see PropertiesPanelHost). */
import { anchorsPanelSection } from "../arrowAnchors/anchorsPanelSection";
import { imagePanelSection } from "../imageProps/imagePanelSection";
import { dataPanelSection } from "../shapeData/dataPanelSection";
import { stylePanelSection } from "../styles/stylePanelSection";
import type { AnyPanelSection } from "./panel";

export const PANEL_SECTIONS: readonly AnyPanelSection[] = [
  imagePanelSection,
  anchorsPanelSection,
  stylePanelSection,
  dataPanelSection,
];
