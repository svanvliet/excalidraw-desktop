/**
 * "Style" properties-panel section (docs/styles.md): link the selection to a named style.
 *
 * Progressive disclosure (FR-65, D-DX19): the row shows only while the selection uses a style
 * (or follows a styled master); otherwise "Apply style" in the strip's "+" menu reveals it.
 */
import type { El } from "../../agent/scene/draft";
import { StylesIcon } from "../icons";
import type { PanelSection } from "../propertiesPanel/panel";
import { StyleSection } from "./StyleSection";
import { styleSectionView, type StyleSectionView } from "./stylesView";

export const stylePanelSection: PanelSection<StyleSectionView> = {
  id: "style",
  slot: "top",
  testId: "style-section",
  title: "Style",
  icon: StylesIcon,
  summary: (v) => {
    if (v.master) return `From master${v.master.name ? ` (${v.master.name})` : ""}`;
    const name =
      v.current === "mixed" ? "Mixed" : (v.styles.find((s) => s.id === v.current)?.name ?? "None");
    const n = v.overrides.length;
    return n ? `${name} · ${n} override${n === 1 ? "" : "s"}` : name;
  },
  inUse: (v) => (v.master ? v.master.name !== null : v.current !== null || v.overrides.length > 0),
  more: (v) =>
    v.master ? null : { label: "Apply style", title: "Link the selection to a named style" },
  view: ({ selected, api }) =>
    styleSectionView(
      selected as readonly El[],
      api.getSceneElementsIncludingDeleted() as readonly El[],
    ),
  Component: StyleSection,
};
