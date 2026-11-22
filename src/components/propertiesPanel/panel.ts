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

/** A strip row's inline action, e.g. Create on plain shapes (test id `<testId>-primary`). */
export interface PanelPrimary {
  label: string;
  /** Tooltip, e.g. the shortcut. */
  title?: string;
  disabled?: boolean;
  /** Gets the full editor API (PanelApi only narrows it). */
  run(api: PanelApi): void;
}

/**
 * An entry in the strip's "+" menu (FR-65, D-DX19), e.g. "Add data". With `run` it is a plain
 * command; without, choosing it reveals the section's row (opened) for the current selection.
 */
export interface PanelMore {
  label: string;
  title?: string;
  /** Gets the full editor API (PanelApi only narrows it). */
  run?(api: PanelApi): void;
}

/**
 * One panel section. `view` runs on every scene change, so keep it cheap; its result must be
 * JSON-serialisable (it is diffed by value) and `null` hides the section.
 *
 * "top" sections are rows of the strip at the top of the panel (FR-63, D-DX17): icon, title,
 * one-line `summary`, an optional inline `primary` action and, when `Component` is set, a body
 * that expands inline. Only one row is open at a time (stores/panelStripStore). "bottom"
 * sections are appended at the end of the panel as they are.
 *
 * Progressive disclosure (FR-65, D-DX19): a row with `inUse` shows only while it returns true
 * (the selection already uses the concept) or after the user picks the row's `more` entry from
 * the strip's "+" menu. Otherwise its `more` entry is all that is offered.
 */
export interface PanelSection<V> {
  id: string;
  slot: "top" | "bottom";
  /**
   * Test ids: `<testId>-native` on the host in the panel, `<testId>-dock` in the docked
   * fallback; strip rows add `<testId>-toggle` and `<testId>-primary`. Also the body's CSS class.
   */
  testId: string;
  title: string;
  /** A NativeIcon from components/icons (sized by the strip CSS). */
  icon: ComponentType;
  /** One line next to the title; keep it short (it is ellipsised). */
  summary(view: V): string;
  primary?(view: V): PanelPrimary | null;
  /** Gates the row (see above); omit to always show it when `view` is non-null. */
  inUse?(view: V): boolean;
  /** The "+" menu entry offered while the row is gated out. */
  more?(view: V): PanelMore | null;
  view(ctx: PanelContext): V | null;
  /** The expanded body. A row without one has no chevron (title, summary and primary only). */
  Component?: ComponentType<{ view: V; api: PanelApi }>;
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

/** Identifies the current selection, so a row revealed from "+" stays revealed only for it. */
export function selectionKey(api: PanelApi): string {
  const ids = api.getAppState().selectedElementIds;
  return Object.keys(ids)
    .filter((id) => ids[id])
    .sort()
    .join(",");
}

/**
 * Splits the sections with a view into the rows to show and the "+" menu entries of gated-out
 * rows (FR-65). `revealed` holds ids the user opened from "+" for this selection.
 */
export function stripLayout(
  sections: readonly AnyPanelSection[],
  views: Views,
  revealed: ReadonlySet<string>,
): { shown: AnyPanelSection[]; more: Array<{ section: AnyPanelSection; entry: PanelMore }> } {
  const shown: AnyPanelSection[] = [];
  const more: Array<{ section: AnyPanelSection; entry: PanelMore }> = [];
  for (const s of sections) {
    if (!(s.id in views)) continue;
    const v = views[s.id];
    if (!s.inUse || s.inUse(v) || revealed.has(s.id)) {
      shown.push(s);
      continue;
    }
    const entry = s.more?.(v);
    if (entry) more.push({ section: s, entry });
  }
  return { shown, more };
}

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
