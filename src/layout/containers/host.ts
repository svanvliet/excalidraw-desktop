/**
 * Smart containers host: the user-facing commands (panel, shortcut, menu). Each runs a Draft
 * action and commits it as exactly one undo step; the live re-flow rule itself is installed with
 * the components reactor (extensions/components/host.ts).
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Draft, ToolError } from "../../agent/scene/draft";
import { commitUndoable } from "../../agent/scene/turns";
import { componentsReactor } from "../../extensions/components/host";
import { log } from "../../lib/logger";
import {
  addToContainer,
  childUnits,
  resolveContainer,
  makeContainer,
  moveChild,
  removeContainer,
  removeFromContainer,
  updateContainer,
  type ContainerChanges,
} from "./actions";
import { containerGroupOf, isActiveBox, readDef, type ContainerDef } from "./model";

type Api = ExcalidrawImperativeAPI;
type El = ExcalidrawElement;

/** The panel's narrower API works too; it's the same object, so `setToast` is there at runtime. */
type CommandApi = Pick<Api, "getAppState" | "getSceneElementsIncludingDeleted" | "updateScene"> &
  Partial<Pick<Api, "setToast">>;

function selectedIds(api: Pick<Api, "getAppState">): string[] {
  const sel = api.getAppState().selectedElementIds;
  return Object.keys(sel).filter((id) => sel[id]);
}

/** Run a container action as one undo step; user-actionable errors become a toast. */
export function runContainerCommand<T>(api: CommandApi, action: (draft: Draft) => T): T | null {
  if (api.getAppState().viewModeEnabled) return null;
  componentsReactor(api as Api)?.flush();
  try {
    const draft = new Draft(api.getSceneElementsIncludingDeleted());
    const out = action(draft);
    if (draft.changed.size) commitUndoable(api as Api, draft);
    return out;
  } catch (err) {
    if (err instanceof ToolError) api.setToast?.({ message: err.message });
    else {
      log.error("containers: action failed", err);
      api.setToast?.({ message: "That stack action failed. See the log for details." });
    }
    return null;
  }
}

function selectGroup(api: CommandApi, group: string) {
  const ids = api
    .getSceneElementsIncludingDeleted()
    .filter((e) => !e.isDeleted && e.groupIds.includes(group))
    .map((e) => e.id);
  api.updateScene({
    appState: {
      selectedGroupIds: { [group]: true },
      selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
      editingGroupId: null,
    } as never,
  });
}

/** Wrap the selection in a container and select it. */
export function makeContainerFromSelection(api: CommandApi, changes?: ContainerChanges) {
  const ids = selectedIds(api);
  if (!ids.length) {
    api.setToast?.({ message: "Select the shapes to stack first." });
    return null;
  }
  const res = runContainerCommand(api, (d) => makeContainer(d, ids, changes));
  if (res) selectGroup(api, res.groupId);
  return res;
}

export const updateContainerSettings = (api: CommandApi, ref: string, changes: ContainerChanges) =>
  runContainerCommand(api, (d) => updateContainer(d, ref, changes));

export const unmakeContainer = (api: CommandApi, ref: string) =>
  runContainerCommand(api, (d) => removeContainer(d, ref));

export const moveContainerChild = (
  api: CommandApi,
  containerId: string,
  id: string,
  index: number,
) => runContainerCommand(api, (d) => moveChild(d, id, index, containerId));

export const takeOutOfContainer = (api: CommandApi, ids: readonly string[]) =>
  runContainerCommand(api, (d) => removeFromContainer(d, ids));

export const putInContainer = (
  api: CommandApi,
  ref: string,
  ids: readonly string[],
  index?: number,
) => runContainerCommand(api, (d) => addToContainer(d, ref, ids, index));

// --- panel view ------------------------------------------------------------------------------

export interface ContainerPanelView {
  /** `make`: no container involved; `container`: a whole container is selected; `child`: one
   * child (unit) of a container is selected. */
  mode: "make" | "container" | "child";
  containerId: string | null;
  def: Omit<ContainerDef, "gi"> | null;
  /** Child mode: the selection's position among the container's children. */
  index: number;
  count: number;
  childIds: string[];
}

const MAKE: ContainerPanelView = {
  mode: "make",
  containerId: null,
  def: null,
  index: 0,
  count: 0,
  childIds: [],
};

function containerOfGroup(draft: Draft, g: string) {
  try {
    const c = resolveContainer(draft, g);
    return c.group === g ? c : null;
  } catch {
    return null;
  }
}

function strip(def: ContainerDef): Omit<ContainerDef, "gi"> {
  const { gi: _gi, ...rest } = def;
  return rest;
}

/**
 * What the Container section shows for `selected`. Selecting a container (Excalidraw selects the
 * whole group) shows its settings; selecting exactly one child inside it (group-edit mode) adds
 * the reorder / take-out actions; a plain multi-selection offers "make container".
 */
export function containerPanelView(
  scene: readonly El[],
  selected: readonly El[],
): ContainerPanelView | null {
  if (!selected.length) return null;
  const sel = new Set(selected.map((e) => e.id));
  const boxes = selected.filter(isActiveBox);
  const hasGroups = selected.some((e) => e.groupIds.length);
  if (!boxes.length && !hasGroups) return selected.length > 1 ? MAKE : null;
  const draft = new Draft(scene);
  const whole = boxes
    .map((b) => ({ b, g: containerGroupOf(b)! }))
    .filter(({ g }) => draft.live().every((e) => !e.groupIds.includes(g) || sel.has(e.id)))
    .sort((a, b) => a.b.groupIds.length - b.b.groupIds.length);
  if (whole.length) {
    const { b } = whole[0];
    const others = selected.filter((e) => !e.groupIds.includes(whole[0].g));
    if (!others.length) {
      return { ...MAKE, mode: "container", containerId: b.id, def: strip(readDef(b)!) };
    }
  }
  // Innermost container the whole selection sits inside (without its box) and that has exactly
  // one child fully selected: that child is "selected in" the container.
  for (const g of selected[0].groupIds) {
    if (!selected.every((e) => e.groupIds.includes(g))) continue;
    const c = containerOfGroup(draft, g);
    if (!c || sel.has(c.box.id)) continue;
    const units = childUnits(draft, c);
    const hit = units.filter((u) => u.ids.some((id) => sel.has(id)));
    if (hit.length !== 1) break;
    return {
      mode: "child",
      containerId: c.box.id,
      def: strip(c.def),
      index: units.indexOf(hit[0]),
      count: units.length,
      childIds: [...sel],
    };
  }
  return selected.length > 1 ? MAKE : null;
}

// --- shortcut --------------------------------------------------------------------------------

/** Alt/Option+Shift+A: make a container from the selection. Matched on `code` (Option). */
export function isMakeContainerShortcut(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.code === "KeyA" && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
}
