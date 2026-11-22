/**
 * Components v1 host: one reactor per editor (also running the smart-container rule), plus the
 * functions and hook the UI calls.
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
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { BinaryFileData, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useState } from "react";
import { Draft, ToolError, type El } from "../../agent/scene/draft";
import { commitUndoable } from "../../agent/scene/turns";
import { log } from "../../lib/logger";
import { createReactor, type Reactor } from "../reactor/reactor";
import {
  createComponent,
  defineProperty,
  detachInstance,
  insertInstance,
  removeProperty,
  resetOverrides,
  resolveInstance,
  setOverrides,
  setProperties,
  type InsertOptions,
  type OverrideEntry,
  type PropertyInput,
} from "./actions";
import {
  elementComponentInfo,
  listComponents,
  type ComponentInfo,
  type ElementComponentInfo,
} from "./model";
import { createAnchorRule, type AnchorRule } from "../anchors/rule";
import { createStyleRule } from "../styles/rule";
import {
  adoptAsMaster,
  applyMasterEdit,
  demoteMaster,
  dematerialize,
  liveMasterGroup,
  materialize,
  withMaster,
  type ComponentDefinition,
} from "./library";
import { createComponentRule } from "./rule";
import { createContainerRule, createHoldTracker } from "../../layout/containers/rule";

type Api = ExcalidrawImperativeAPI;

const engines = new WeakMap<Api, Reactor>();
const holds = new WeakMap<Api, ReturnType<typeof createHoldTracker>>();
const remotes = new WeakMap<Api, Api>();
const anchorRules = new WeakMap<Api, AnchorRule>();

export function installComponents(
  api: Api,
  opts: { schedule?: (cb: () => void) => () => void } = {},
): Reactor {
  let reactor = engines.get(api);
  if (!reactor) {
    const anchors = createAnchorRule();
    anchorRules.set(api, anchors);
    const hold = createHoldTracker();
    reactor = createReactor({
      api,
      // Order matters (D-DX12, D-DX13; docs/styles.md § "Rule order", docs/containers.md §3):
      // a style writes master children (and grows text), containers then re-flow around them,
      // components then copy all of it to instances, and line anchors finally re-snap pinned
      // arrow ends to the shapes the earlier rules moved (D-DX15).
      rules: [
        createStyleRule(),
        createContainerRule({ held: hold.held }),
        createComponentRule(),
        anchors,
      ],
      apply: "mutate",
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
    });
    hold.attach(api, reactor);
    engines.set(api, reactor);
    holds.set(api, hold);
  }
  return reactor;
}

export function componentsReactor(api: Api): Reactor | undefined {
  return engines.get(api);
}

/** The editor's line-anchors rule (suspends pinned arrows while the user drags them). */
export function lineAnchorRule(api: Api): AnchorRule | undefined {
  return anchorRules.get(api);
}

export function uninstallComponents(api: Api): void {
  engines.get(api)?.dispose();
  engines.delete(api);
  anchorRules.delete(api);
  holds.get(api)?.dispose();
  holds.delete(api);
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

/**
 * Make the selection a component and select it: the selection becomes the component's first
 * instance, and the master lives off-canvas (FR-64, D-DX18).
 */
export function createComponentFromSelection(api: Api, name?: string) {
  const res = runComponentCommand(api, (d) => {
    const c = createComponent(d, selectedIds(api), name);
    return { ...c, groupId: demoteMaster(d, c.masterGroupId) };
  });
  if (res) {
    api.updateScene({
      appState: {
        selectedGroupIds: { [res.groupId]: true },
        selectedElementIds: Object.fromEntries(res.ids.map((id) => [id, true])),
      } as never,
    });
    api.setToast({ message: "Component created. Duplicate it to make instances.", duration: 2500 });
  }
  return res;
}

/** Run `fn` with the instance's component master present (rebuilt for the draft when needed). */
const onInstance =
  <T>(instance: string, fn: (d: Draft) => T) =>
  (d: Draft) =>
    withMaster(d, resolveInstance(d, instance).componentId, () => fn(d), instance);
const onComponent =
  <T>(componentId: string, fn: (d: Draft) => T) =>
  (d: Draft) =>
    withMaster(d, componentId, () => fn(d));

/**
 * Replace a component's master with `edited` (the master-edit canvas's elements) and update
 * every instance, as one undo step (FR-64). `files` are the images the edited master uses. When
 * the master lives off-canvas it stays off-canvas. No change, no undo step.
 */
export function applyComponentMasterEdit(
  api: Api,
  componentId: string,
  edited: readonly El[],
  files: readonly BinaryFileData[] = [],
): boolean {
  if (api.getAppState().viewModeEnabled) return false;
  if (files.length) api.addFiles([...files]);
  return runComponentCommand(api, (d) => (applyMasterEdit(d, componentId, edited), true)) ?? false;
}

/**
 * Turn masters left on the canvas by older builds into instances (FR-64): the master moves
 * off-canvas and its elements stay where they are. Not an undo step. Returns how many.
 */
export function demoteLegacyMasters(api: Api): number {
  if (api.getAppState().viewModeEnabled) return 0;
  engines.get(api)?.flush();
  const draft = new Draft(api.getSceneElementsIncludingDeleted());
  let n = 0;
  try {
    for (const c of listComponents(draft.toArray())) {
      const group = liveMasterGroup(draft, c.componentId);
      if (!group) continue;
      demoteMaster(draft, group);
      n++;
    }
  } catch (err) {
    log.error("components: demoting legacy masters failed", err);
    return 0;
  }
  if (draft.changed.size)
    api.updateScene({ elements: draft.toArray(), captureUpdate: CaptureUpdateAction.NEVER });
  if (n) log.info(`components: moved ${n} on-canvas master(s) off-canvas`);
  return n;
}

export const insertComponentInstance = (api: Api, componentId: string, opts?: InsertOptions) =>
  runComponentCommand(
    api,
    onComponent(componentId, (d) => insertInstance(d, componentId, opts)),
  );
export const setInstanceOverrides = (api: Api, instance: string, entries: OverrideEntry[]) =>
  runComponentCommand(
    api,
    onInstance(instance, (d) => setOverrides(d, instance, entries)),
  );
export const resetInstanceOverrides = (
  api: Api,
  instance: string,
  opts?: Parameters<typeof resetOverrides>[2],
) =>
  runComponentCommand(
    api,
    onInstance(instance, (d) => resetOverrides(d, instance, opts)),
  );
export const detachComponentInstance = (api: Api, instance: string) =>
  runComponentCommand(api, (d) => detachInstance(d, instance));

/**
 * Library-backed masters (docs/components.md § Library). Each is one undo step and returns
 * null in view mode or when it fails (the reason is shown as a toast), like the actions above.
 */
export const materializeMaster = (api: Api, instanceGroupId: string): string | null =>
  runComponentCommand(api, (d) => materialize(d, instanceGroupId));
export const dematerializeMaster = (api: Api, masterGroupId: string): ComponentDefinition | null =>
  runComponentCommand(api, (d) => dematerialize(d, masterGroupId));
export const adoptInstanceAsMaster = (api: Api, instanceGroupId: string): string | null =>
  runComponentCommand(api, (d) => adoptAsMaster(d, instanceGroupId));

export const defineComponentProperty = (api: Api, componentId: string, input: PropertyInput) =>
  runComponentCommand(
    api,
    onComponent(componentId, (d) => defineProperty(d, componentId, input)),
  );
export const removeComponentProperty = (api: Api, componentId: string, prop: string) =>
  runComponentCommand(
    api,
    onComponent(componentId, (d) => removeProperty(d, componentId, prop)),
  );
export const setInstanceProperties = (
  api: Api,
  instance: string,
  values: Record<string, unknown>,
  opts?: { nested?: string },
) =>
  runComponentCommand(
    api,
    onInstance(instance, (d) => setProperties(d, instance, values, opts)),
  );

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
