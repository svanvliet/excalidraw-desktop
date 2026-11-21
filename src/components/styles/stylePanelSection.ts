/** "Style" properties-panel section (docs/styles.md): link the selection to a named style. */
import type { El } from "../../agent/scene/draft";
import type { PanelSection } from "../propertiesPanel/panel";
import { StyleSection } from "./StyleSection";
import { styleSectionView, type StyleSectionView } from "./stylesView";

export const stylePanelSection: PanelSection<StyleSectionView> = {
  id: "style",
  slot: "bottom",
  testId: "style-section",
  view: ({ selected, api }) =>
    styleSectionView(
      selected as readonly El[],
      api.getSceneElementsIncludingDeleted() as readonly El[],
    ),
  Component: StyleSection,
};
