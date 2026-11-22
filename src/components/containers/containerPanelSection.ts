/**
 * "Stack" properties-panel section (docs/plan.md D-DX13, docs/containers.md): make a smart
 * container from the selection, edit a selected container's stack settings, or reorder / take
 * out the child selected inside one. The UI calls containers "stacks" (D-DX19); code ids keep
 * "container".
 *
 * Progressive disclosure (FR-65): a plain multi-selection gets no row, just "Make stack" in the
 * strip's "+" menu.
 */
import { makeContainerFromSelection } from "../../layout/containers/host";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { containerPanelView, type ContainerPanelView } from "../../layout/containers/host";
import { StackVerticalIcon } from "../icons";
import type { PanelSection } from "../propertiesPanel/panel";
import { ContainerSection } from "./ContainerSection";

export const containerPanelSection: PanelSection<ContainerPanelView> = {
  id: "container",
  slot: "top",
  testId: "container-section",
  title: "Stack",
  icon: StackVerticalIcon,
  summary: (v) =>
    v.mode === "make"
      ? "Not in a stack"
      : v.mode === "child"
        ? `Item ${v.index + 1} of ${v.count}`
        : `${v.def?.direction ?? "vertical"} · gap ${v.def?.gap ?? 0}`,
  inUse: (v) => v.mode !== "make",
  more: (v) =>
    v.mode === "make"
      ? {
          label: "Make stack",
          title: "Alt+Shift+A",
          run: (api) => makeContainerFromSelection(api),
        }
      : null,
  view({ api, selected }) {
    if (!selected.length) return null;
    const scene = api.getSceneElementsIncludingDeleted() as readonly ExcalidrawElement[];
    return containerPanelView(scene, selected);
  },
  Component: ContainerSection,
};
