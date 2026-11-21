/**
 * Components v1 host: one reactor per editor, plus the functions and hook the UI calls.
 *
 *  - `installComponents(api)` (idempotent) starts the live sync for an editor; patches are
 *    applied in place (`apply: "mutate"`) and are never undo steps of their own.
 *  - `remoteApi(api)` wraps an API so collab's `updateScene` applies are tagged as remote: a
 *    peer running this app already sent the synced instances, so re-deriving would only echo.
 *  - `runComponentCommand` runs a draft action and commits it as exactly one undo step.
 *
 * Mutate-safety audit (docs/components.md): autosave serialises the live scene lazily; the agent
 * turn tracker and the collab engine compare element versions (which `mutateElement` bumps), not
 * object identity; fontRefresh caches by a WeakMap it only reads. None hold stale references.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useState } from "react";
import { Draft, ToolError } from "../../agent/scene/draft";
import { commitUndoable } from "../../agent/scene/turns";
import { log } from "../../lib/logger";
import { createReactor, type Reactor } from "../reactor/reactor";
import {
  createComponent,
  detachInstance,
  insertInstance,
  resetOverrides,
  setOverrides,
  type InsertOptions,
  type OverrideEntry,
} from "./actions";
import {
  elementComponentInfo,
  listComponents,
  type ComponentInfo,
  type ElementComponentInfo,
} from "./model";
import { createComponentRule } from "./rule";

type Api = ExcalidrawImperativeAPI;

const engines = new WeakMap<Api, Reactor>();
const remotes = new WeakMap<Api, Api>();

export function installComponents(
  api: Api,
  opts: { schedule?: (cb: () => void) => () => void } = {},
): Reactor {
  let reactor = engines.get(api);
  if (!reactor) {
    reactor = createReactor({
      api,
      rules: [createComponentRule()],
      apply: "mutate",
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
    });
    engines.set(api, reactor);
  }
  return reactor;
}

export function componentsReactor(api: Api): Reactor | undefined {
  return engines.get(api);
}

export function uninstallComponents(api: Api): void {
  engines.get(api)?.dispose();
  engines.delete(api);
}

/** Forget sync state and re-index from the current scene (file opened into this editor). */
export function reseedComponents(api: Api): void {
  engines.get(api)?.reseed();
}

/** `api` with `updateScene` tagged as a remote apply (for the collab engine). */
export function remoteApi<T extends Api | null>(api: T): T {
  if (!api) return api;
  let wrapped = remotes.get(api);
  if (!wrapped) {
    wrapped = new Proxy(api, {
      get(target, prop, receiver) {
        if (prop !== "updateScene") return Reflect.get(target, prop, receiver);
        return (data: Parameters<Api["updateScene"]>[0]) => {
          const reactor = engines.get(target);
          return reactor
            ? reactor.wrapRemoteApi(target).updateScene(data)
            : target.updateScene(data);
        };
      },
    });
    remotes.set(api, wrapped);
  }
  return wrapped as T;
}

function selectedIds(api: Api): string[] {
  const sel = api.getAppState().selectedElementIds;
  return Object.keys(sel).filter((id) => sel[id]);
}

/**
 * Run a components action against the current scene and commit it as one undo step. Errors
 * the user can act on are shown as a toast; returns the action's result or null.
 */
export function runComponentCommand<T>(api: Api, action: (draft: Draft) => T): T | null {
  if (api.getAppState().viewModeEnabled) return null;
  engines.get(api)?.flush();
  try {
    const draft = new Draft(api.getSceneElementsIncludingDeleted());
    const out = action(draft);
    if (draft.changed.size) commitUndoable(api, draft);
    return out;
  } catch (err) {
    if (err instanceof ToolError) api.setToast({ message: err.message });
    else {
      log.error("components: action failed", err);
      api.setToast({ message: "That component action failed. See the log for details." });
    }
    return null;
  }
}

/** Make the selection a component and select its master. */
export function createComponentFromSelection(api: Api, name?: string) {
  const res = runComponentCommand(api, (d) => createComponent(d, selectedIds(api), name));
  if (res) {
    api.updateScene({
      appState: {
        selectedGroupIds: { [res.masterGroupId]: true },
        selectedElementIds: Object.fromEntries(res.ids.map((id) => [id, true])),
      } as never,
    });
    api.setToast({ message: "Component created. Duplicate it to make instances.", duration: 2500 });
  }
  return res;
}

export const insertComponentInstance = (api: Api, componentId: string, opts?: InsertOptions) =>
  runComponentCommand(api, (d) => insertInstance(d, componentId, opts));
export const setInstanceOverrides = (api: Api, instance: string, entries: OverrideEntry[]) =>
  runComponentCommand(api, (d) => setOverrides(d, instance, entries));
export const resetInstanceOverrides = (
  api: Api,
  instance: string,
  opts?: Parameters<typeof resetOverrides>[2],
) => runComponentCommand(api, (d) => resetOverrides(d, instance, opts));
export const detachComponentInstance = (api: Api, instance: string) =>
  runComponentCommand(api, (d) => detachInstance(d, instance));

export function sceneComponents(api: Api): ComponentInfo[] {
  return listComponents(api.getSceneElementsIncludingDeleted());
}

export interface ComponentSelection {
  /** Component info for each selected element that belongs to one. */
  elements: Array<{ id: string } & ElementComponentInfo>;
  /** Distinct components in the selection. */
  componentIds: string[];
}

function readSelection(api: Api): ComponentSelection {
  const sel = new Set(selectedIds(api));
  const elements: ComponentSelection["elements"] = [];
  for (const el of api.getSceneElements()) {
    if (!sel.has(el.id)) continue;
    const info = elementComponentInfo(el);
    if (info) elements.push({ id: el.id, ...info });
  }
  return { elements, componentIds: [...new Set(elements.map((e) => e.componentId))] };
}

const sameSelection = (a: ComponentSelection, b: ComponentSelection) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Component info for the current selection, kept up to date (for the Components UI lane). */
export function useComponentSelection(api: Api | null): ComponentSelection {
  const [state, setState] = useState<ComponentSelection>({ elements: [], componentIds: [] });
  useEffect(() => {
    if (!api) return;
    const update = () => {
      const next = readSelection(api);
      setState((prev) => (sameSelection(prev, next) ? prev : next));
    };
    update();
    return api.onChange(update);
  }, [api]);
  return state;
}

/** Alt/Option+Cmd/Ctrl+K: temporary trigger for "Create component" until the UI lane lands. */
export function isCreateComponentShortcut(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.code === "KeyK" && e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey;
}

/**
 * Capture-phase keydown handler for the editor's wrapper element. A registered Excalidraw action
 * can't own this shortcut: Excalidraw's hyperlink action matches any Ctrl/Cmd+K (Alt or not), and
 * Excalidraw cancels a shortcut that two actions match. Typing in text fields is left alone.
 */
export function handleComponentShortcut(
  api: Api | null,
  e: KeyboardEvent | React.KeyboardEvent,
): void {
  if (!api || !isCreateComponentShortcut(e)) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  e.stopPropagation();
  createComponentFromSelection(api);
}
