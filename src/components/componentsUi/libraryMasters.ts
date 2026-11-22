/**
 * Library-backed masters (FR-55, D-DX10): the master of a saved component can live in
 * My components instead of on the canvas. The drawing then holds only instances, tagged
 * `source: "library"`. Editing a master happens in the master-edit overlay (FR-66,
 * `MasterEditor.tsx`), never on the canvas.
 *
 * The engine primitives belong to the Component properties lane (`extensions/components/host.ts`):
 *   materializeMaster(api, instanceGroupId) → masterGroupId | null
 *   dematerializeMaster(api, masterGroupId) → definition | null
 *   adoptInstanceAsMaster(api, instanceGroupId) → masterGroupId | null
 * Each is one undo step. They are looked up at runtime: until that engine lands, the UI keeps
 * on-canvas masters only (a lone library instance would be promoted by the v1 engine).
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { El } from "../../agent/scene/draft";
import * as host from "../../extensions/components/host";
import { tagOf } from "../../extensions/components/model";
import { getMyComponents, putMyComponent } from "../../lib/componentLibraryStore";
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
  const all = api.getSceneElementsIncludingDeleted() as readonly El[];
  const ok = await putMyComponent(masterToEntry(all, api.getFiles(), tag.componentId));
  api.setToast({
    message: ok
      ? `Added "${tag.name ?? "Component"}" to My components`
      : "Couldn't save to My components.",
    duration: 2500,
  });
  return ok;
}
