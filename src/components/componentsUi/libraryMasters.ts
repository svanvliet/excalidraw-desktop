/**
 * Library-backed masters (FR-55, D-DX10): the master of a saved component can live in
 * My components instead of on the canvas. The drawing then holds only instances, tagged
 * `source: "library"`, and "Edit master…" brings the master onto the canvas for a while
 * (materialize), then Done saves it back to My components and takes it away again
 * (dematerialize).
 *
 * The engine primitives belong to the Component properties lane (`extensions/components/host.ts`):
 *   materializeMaster(api, instanceGroupId) → masterGroupId | null
 *   dematerializeMaster(api, masterGroupId) → definition | null
 *   adoptInstanceAsMaster(api, instanceGroupId) → masterGroupId | null
 * Each is one undo step. They are looked up at runtime: until that engine lands, the UI keeps
 * on-canvas masters only (a lone library instance would be promoted by the v1 engine).
 *
 * Editing state is per editor and kept here (not in React state) so the Components tab, the
 * properties panel and the banner agree on it.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useSyncExternalStore } from "react";
import type { El } from "../../agent/scene/draft";
import * as host from "../../extensions/components/host";
import { runComponentCommand } from "../../extensions/components/host";
import { listComponents, tagOf } from "../../extensions/components/model";
import { getMyComponents, putMyComponent } from "../../lib/componentLibraryStore";
import { log } from "../../lib/logger";
import { librarySourceOf, masterToEntry } from "./libraryCodec";

type Api = ExcalidrawImperativeAPI;

export interface LibraryMasterEngine {
  materializeMaster(api: Api, instanceGroupId: string): string | null | undefined;
  dematerializeMaster(api: Api, masterGroupId: string): unknown;
  adoptInstanceAsMaster(api: Api, instanceGroupId: string): string | null | undefined;
}

let override: LibraryMasterEngine | null | undefined;

/** The engine's library-master primitives, or null while the engine doesn't have them. */
export function libraryMasterEngine(): LibraryMasterEngine | null {
  if (override !== undefined) return override;
  const h = host as unknown as Partial<LibraryMasterEngine>;
  return typeof h.materializeMaster === "function" &&
    typeof h.dematerializeMaster === "function" &&
    typeof h.adoptInstanceAsMaster === "function"
    ? (h as LibraryMasterEngine)
    : null;
}

/** Tests only: force the engine (or its absence). `undefined` restores the runtime lookup. */
export function __setLibraryMasterEngineForTest(engine: LibraryMasterEngine | null | undefined) {
  override = engine;
}

// --- Editing sessions ---------------------------------------------------------------------

export interface MasterEdit {
  componentId: string;
  name: string;
  masterGroupId: string;
  /** The component's instances as they were before editing, for Cancel. */
  before: El[];
}

const edits = new WeakMap<Api, MasterEdit>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function masterEditOf(api: Api | null): MasterEdit | null {
  return (api && edits.get(api)) ?? null;
}

export function useMasterEdit(api: Api | null): MasterEdit | null {
  return useSyncExternalStore(
    subscribe,
    () => masterEditOf(api),
    () => masterEditOf(api),
  );
}

function instancesOf(api: Api, componentId: string): El[] {
  return (api.getSceneElements() as readonly El[]).filter((e) => {
    const t = tagOf(e);
    return t?.role === "instance" && t.componentId === componentId;
  });
}

/** True when the component's instances here are library-backed (its master is in My components). */
export function isLibraryBacked(api: Api, componentId: string): boolean {
  return instancesOf(api, componentId).some((e) => !!librarySourceOf(e));
}

/** True when this machine's My components has the library-backed instance's definition. */
export function hasLibraryEntry(componentId: string, libraryId?: string): boolean {
  const id = libraryId ?? componentId;
  return getMyComponents().some((c) => c.id === id);
}

/** "Edit master…": put the library master on the canvas next to the instance and select it. */
export function editLibraryMaster(api: Api, instanceGroupId: string): boolean {
  const engine = libraryMasterEngine();
  if (!engine || edits.has(api)) return false;
  const els = api.getSceneElements() as readonly El[];
  const anyEl = els.find((e) => e.groupIds.includes(instanceGroupId) && tagOf(e));
  const tag = tagOf(anyEl);
  if (!tag || tag.role !== "instance") return false;
  const before = instancesOf(api, tag.componentId).map((e) => structuredClone(e));
  const masterGroupId = engine.materializeMaster(api, instanceGroupId);
  if (!masterGroupId) return false;
  const info = listComponents(api.getSceneElements() as readonly El[]).find(
    (c) => c.componentId === tag.componentId,
  );
  edits.set(api, {
    componentId: tag.componentId,
    name: info?.name ?? tag.name ?? "Component",
    masterGroupId,
    before,
  });
  notify();
  const master = (api.getSceneElements() as readonly El[]).filter((e) =>
    info?.masterIds.includes(e.id),
  );
  if (master.length) api.scrollToContent(master, { animate: true });
  return true;
}

/** Done: save the edited master to My components (with its images), then take it off the canvas. */
export async function finishMasterEdit(api: Api): Promise<boolean> {
  const edit = edits.get(api);
  const engine = libraryMasterEngine();
  if (!edit || !engine) return false;
  let saved = false;
  try {
    saved = await putMyComponent(
      masterToEntry(api.getSceneElements() as readonly El[], api.getFiles(), edit.componentId),
    );
  } catch (err) {
    log.error("components: saving the edited master failed", err);
  }
  if (!saved) {
    api.setToast({ message: "Couldn't save the master to My components. It stays on the canvas." });
    return false;
  }
  edits.delete(api);
  notify();
  engine.dematerializeMaster(api, edit.masterGroupId);
  api.setToast({ message: `Saved "${edit.name}" to My components`, duration: 2500 });
  return true;
}

/**
 * Cancel: one undo step that takes the master away and puts the component's instances back as
 * they were before editing (children the edit added are removed).
 */
export function cancelMasterEdit(api: Api): boolean {
  const edit = edits.get(api);
  if (!edit) return false;
  edits.delete(api);
  notify();
  const els = api.getSceneElements() as readonly El[];
  const info = listComponents(els).find((c) => c.componentId === edit.componentId);
  const before = new Map(edit.before.map((e) => [e.id, e]));
  const added = instancesOf(api, edit.componentId).filter((e) => !before.has(e.id));
  runComponentCommand(api, (d) => {
    for (const id of info?.masterIds ?? []) if (d.has(id)) d.update(id, { isDeleted: true });
    for (const e of added) d.update(e.id, { isDeleted: true });
    for (const old of edit.before) {
      if (!d.has(old.id)) continue;
      const {
        id: _id,
        version: _v,
        versionNonce: _n,
        updated: _u,
        ...rest
      } = old as El & Record<string, unknown>;
      d.update(old.id, rest, true);
    }
  });
  return true;
}

/** Tests only. */
export function __clearMasterEdit(api: Api) {
  edits.delete(api);
  notify();
}

/** "Add to my components" for a library instance this machine doesn't have. */
export async function adoptLibraryInstance(api: Api, instanceGroupId: string): Promise<boolean> {
  const engine = libraryMasterEngine();
  if (!engine) return false;
  const masterGroupId = engine.adoptInstanceAsMaster(api, instanceGroupId);
  if (!masterGroupId) return false;
  const els = api.getSceneElements() as readonly El[];
  const master = els.find((e) => e.groupIds.includes(masterGroupId) && tagOf(e));
  const tag = tagOf(master);
  if (!tag) return false;
  const ok = await putMyComponent(masterToEntry(els, api.getFiles(), tag.componentId));
  api.setToast({
    message: ok
      ? `Added "${tag.name ?? "Component"}" to My components`
      : "Couldn't save to My components.",
    duration: 2500,
  });
  return ok;
}

/**
 * "Move to My components": save an on-canvas master to My components, then take it off the
 * canvas; its instances become library-backed.
 */
export async function moveMasterToLibrary(api: Api, componentId: string): Promise<boolean> {
  const engine = libraryMasterEngine();
  if (!engine) return false;
  const info = listComponents(api.getSceneElements() as readonly El[]).find(
    (c) => c.componentId === componentId,
  );
  if (!info?.masterGroupId) return false;
  let saved = false;
  try {
    saved = await putMyComponent(
      masterToEntry(api.getSceneElements() as readonly El[], api.getFiles(), componentId),
    );
  } catch (err) {
    log.error("components: move to My components failed", err);
  }
  if (!saved) {
    api.setToast({ message: "Couldn't save to My components. The master stays on the canvas." });
    return false;
  }
  engine.dematerializeMaster(api, info.masterGroupId);
  api.setToast({ message: `Moved "${info.name ?? "Component"}" to My components`, duration: 2500 });
  return true;
}
