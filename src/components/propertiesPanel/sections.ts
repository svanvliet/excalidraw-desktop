/** Every properties-panel section, in display order within each slot (see PropertiesPanelHost). */
import { imagePanelSection } from "../imageProps/imagePanelSection";
import { dataPanelSection } from "../shapeData/dataPanelSection";
import type { AnyPanelSection } from "./panel";

export const PANEL_SECTIONS: readonly AnyPanelSection[] = [imagePanelSection, dataPanelSection];
