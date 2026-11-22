/**
 * Every properties-panel section, in display order within each slot (see PropertiesPanelHost):
 * the strip's rows, most-used concept first.
 */
import { componentPanelSection } from "../componentsUi/componentPanelSection";
import { propsPanelSection } from "../componentProps/propsPanelSection";
import { anchorsPanelSection } from "../arrowAnchors/anchorsPanelSection";
import { containerPanelSection } from "../containers/containerPanelSection";
import { imagePanelSection } from "../imageProps/imagePanelSection";
import { dataPanelSection } from "../shapeData/dataPanelSection";
import { stylePanelSection } from "../styles/stylePanelSection";
import type { AnyPanelSection } from "./panel";

export const PANEL_SECTIONS: readonly AnyPanelSection[] = [
  componentPanelSection,
  propsPanelSection,
  imagePanelSection,
  anchorsPanelSection,
  containerPanelSection,
  stylePanelSection,
  dataPanelSection,
];
