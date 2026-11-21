/**
 * Named styles host: the functions and hook the UI calls. The live sync runs as the "styles" rule
 * of the editor's reactor (installed with the components rule in `installComponents`).
 *
 * `runStyleCommand` runs a draft action, brings components in line (a styled master child reaches
 * its instances) and commits the result as exactly one undo step.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useState } from "react";
import { Draft, ToolError } from "../../agent/scene/draft";
import { commitUndoable } from "../../agent/scene/turns";
import { log } from "../../lib/logger";
import { syncEdited } from "../components/actions";
import { componentsReactor } from "../components/host";
import {
  applyStyle,
  createStyle,
  deleteStyle,
  pushOverridesToStyle,
  resetStyleOverrides,
  updateStyle,
  type StyleUpdate,
} from "./actions";
import {
  elementStyleInfo,
  listStyles,
  type ElementStyleInfo,
  type StyleInfo,
  type StyleKey,
} from "./model";

type Api = ExcalidrawImperativeAPI;

export function selectedIds(api: Api): string[] {
  const sel = api.getAppState().selectedElementIds;
  return Object.keys(sel).filter((id) => sel[id]);
}

export function runStyleCommand<T>(api: Api, action: (draft: Draft) => T): T | null {
  if (api.getAppState().viewModeEnabled) return null;
  componentsReactor(api)?.flush();
  try {
    const draft = new Draft(api.getSceneElementsIncludingDeleted());
    const out = action(draft);
    syncEdited(draft);
    if (draft.changed.size) commitUndoable(api, draft);
    return out;
  } catch (err) {
    if (err instanceof ToolError) api.setToast({ message: err.message });
    else {
      log.error("styles: action failed", err);
      api.setToast({ message: "That style action failed. See the log for details." });
    }
    return null;
  }
}

export const createStyleFromSelection = (api: Api, name?: string) =>
  runStyleCommand(api, (d) => createStyle(d, selectedIds(api), name));
export const applyStyleToSelection = (api: Api, styleId: string | null) =>
  runStyleCommand(api, (d) => applyStyle(d, selectedIds(api), styleId));
export const updateSceneStyle = (api: Api, styleId: string, update: StyleUpdate) =>
  runStyleCommand(api, (d) => updateStyle(d, styleId, update));
export const deleteSceneStyle = (api: Api, styleId: string) =>
  runStyleCommand(api, (d) => deleteStyle(d, styleId));
export const resetSelectionStyleOverrides = (api: Api, ids: string[], keys?: StyleKey[]) =>
  runStyleCommand(api, (d) => resetStyleOverrides(d, ids, keys));
export const pushElementOverridesToStyle = (api: Api, elementId: string) =>
  runStyleCommand(api, (d) => pushOverridesToStyle(d, elementId));

export function sceneStyles(api: Api): StyleInfo[] {
  return listStyles(api.getSceneElementsIncludingDeleted());
}

/** Select every element linked to a style. */
export function selectStyleElements(api: Api, styleId: string): void {
  const style = sceneStyles(api).find((s) => s.id === styleId);
  if (!style) return;
  api.updateScene({
    appState: {
      selectedElementIds: Object.fromEntries(style.elementIds.map((id) => [id, true])),
      selectedGroupIds: {},
    } as never,
  });
}

export interface StyleSelection {
  /** Style info for each selected element linked to one (instance children flagged). */
  elements: Array<{ id: string } & ElementStyleInfo>;
  /** Selected elements (excluding bound text) that could take a style. */
  count: number;
}

function readSelection(api: Api): StyleSelection {
  const sel = new Set(selectedIds(api));
  const elements: StyleSelection["elements"] = [];
  let count = 0;
  const all = api.getSceneElements();
  const byId = new Map(all.map((e) => [e.id, e]));
  for (const el of all) {
    if (!sel.has(el.id)) continue;
    count++;
    const info = elementStyleInfo(el, (id) => byId.get(id));
    if (info) elements.push({ id: el.id, ...info });
  }
  return { elements, count };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The scene's styles, kept up to date. */
export function useSceneStyles(api: Api | null): StyleInfo[] {
  const [state, setState] = useState<StyleInfo[]>([]);
  useEffect(() => {
    if (!api) return;
    const update = () => {
      const next = sceneStyles(api);
      setState((prev) => (same(prev, next) ? prev : next));
    };
    update();
    return api.onChange(update);
  }, [api]);
  return state;
}

/** Style info for the current selection, kept up to date. */
export function useStyleSelection(api: Api | null): StyleSelection {
  const [state, setState] = useState<StyleSelection>({ elements: [], count: 0 });
  useEffect(() => {
    if (!api) return;
    const update = () => {
      const next = readSelection(api);
      setState((prev) => (same(prev, next) ? prev : next));
    };
    update();
    return api.onChange(update);
  }, [api]);
  return state;
}
