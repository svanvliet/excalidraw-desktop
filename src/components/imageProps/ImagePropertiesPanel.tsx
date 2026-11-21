import type { RefObject } from "react";
import { PropertiesPanelHost } from "../propertiesPanel/PropertiesPanelHost";
import type { PanelApi } from "../propertiesPanel/panel";
import { imagePanelSection } from "./imagePanelSection";

export type ImagePanelApi = PanelApi;

const IMAGE_ONLY = [imagePanelSection];

/** The properties-panel host with just the image section (tests). */
export function ImagePropertiesPanel({
  api,
  container,
}: {
  api: ImagePanelApi;
  container: RefObject<HTMLElement | null>;
}) {
  return <PropertiesPanelHost api={api} container={container} sections={IMAGE_ONLY} />;
}
