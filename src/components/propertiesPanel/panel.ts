/** Section registry types and selection logic for PropertiesPanelHost. */
import type { ComponentType } from "react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type PanelApi = Pick<
  ExcalidrawImperativeAPI,
  | "getSceneElements"
  | "getSceneElementsIncludingDeleted"
  | "getAppState"
  | "getFiles"
  | "updateScene"
  | "scrollToContent"
  | "addFiles"
  | "onChange"
>;

/** Where the sections go in Excalidraw 0.18.1's DOM: the desktop panel or the mobile sheet. */
export const PANEL_SELECTOR = ".App-menu__left .panelColumn, .App-mobile-menu .panelColumn";

export interface PanelContext {
  api: PanelApi;
  appState: AppState;
  /** Selected, non-deleted elements in scene order (never empty). */
  selected: readonly ExcalidrawElement[];
}

/**
 * One panel section. `view` runs on every scene change, so keep it cheap; its result must be
 * JSON-serialisable (it is diffed by value) and `null` hides the section.
 */
export interface PanelSection<V> {
  id: string;
  slot: "top" | "bottom";
  /**
   * Host CSS class, and test ids: `<testId>-native` in the panel, `<testId>-dock` in the
   * docked fallback.
   */
  testId: string;
  view(ctx: PanelContext): V | null;
  Component: ComponentType<{ view: V; api: PanelApi }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export type AnyPanelSection = PanelSection<any>;

/** Hidden while the user is mid-gesture or typing, and in view / zen mode. */
export function isBusy(s: AppState): boolean {
  return Boolean(
    s.viewModeEnabled ||
    s.zenModeEnabled ||
    s.newElement ||
    s.editingTextElement ||
    s.resizingElement ||
    s.selectedElementsAreBeingDragged ||
    s.isResizing ||
    s.isRotating ||
    s.multiElement,
  );
}

export type Views = Record<string, unknown>;

export function computeViews(api: PanelApi, sections: readonly AnyPanelSection[]): Views {
  const appState = api.getAppState();
  if (isBusy(appState)) return {};
  const selected = api
    .getSceneElements()
    .filter((el) => appState.selectedElementIds[el.id] && !el.isDeleted);
  if (!selected.length) return {};
  const ctx: PanelContext = { api, appState, selected };
  const views: Views = {};
  for (const s of sections) {
    const v: unknown = s.view(ctx);
    if (v !== null && v !== undefined) views[s.id] = v;
  }
  return views;
}
