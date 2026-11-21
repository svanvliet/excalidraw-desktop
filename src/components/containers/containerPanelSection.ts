/**
 * "Container" properties-panel section (docs/plan.md D-DX13, docs/containers.md): make a smart
 * container from the selection, edit a selected container's stack settings, or reorder / take
 * out the child selected inside one.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { containerPanelView, type ContainerPanelView } from "../../layout/containers/host";
import type { PanelSection } from "../propertiesPanel/panel";
import { ContainerSection } from "./ContainerSection";

export const containerPanelSection: PanelSection<ContainerPanelView> = {
  id: "container",
  slot: "bottom",
  testId: "container-section",
  view({ api, selected }) {
    if (!selected.length) return null;
    const scene = api.getSceneElementsIncludingDeleted() as readonly ExcalidrawElement[];
    return containerPanelView(scene, selected);
  },
  Component: ContainerSection,
};
