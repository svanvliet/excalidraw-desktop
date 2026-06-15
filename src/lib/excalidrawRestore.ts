/**
 * Adapter around Excalidraw's `restore()` helper.
 *
 * Excalidraw's `appState` contains runtime-only fields that don't survive
 * a JSON round-trip — most notably `collaborators`, which is a `Map` that
 * `JSON.stringify` flattens to `{}`. When we feed that back into
 * `<Excalidraw initialData={…} />` the editor calls
 * `appState.collaborators.forEach(...)` and throws synchronously,
 * unmounting the canvas (blank-screen bug).
 *
 * `restore()` from `@excalidraw/excalidraw` is the canonical way to
 * normalize imported scene data: it re-instantiates `collaborators` as
 * a fresh `Map`, drops transient/forbidden fields, and repairs missing
 * defaults on elements. Use it on every code path that loads a scene
 * from disk, autosave, or the persisted session store.
 */
import { restore } from "@excalidraw/excalidraw";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

/** Parsed shape of an `.excalidraw` JSON file (only the keys we care about). */
export interface ImportedSceneLike {
  elements?: unknown;
  appState?: unknown;
  files?: unknown;
}

/**
 * Run imported scene data through Excalidraw's restore helper and return a
 * value safe to pass as `<Excalidraw initialData={…} />`.
 *
 * The local-state args to `restore()` are always `null` for us — there's
 * no "previous in-memory state" to merge with when bootstrapping a tab.
 */
export function restoreInitialData(
  imported: ImportedSceneLike | null | undefined,
): ExcalidrawInitialDataState {
  // `restore` is tolerant of partial data; if `imported` is null it returns
  // a fully-defaulted state.
  const safe = imported ?? {};
  const restored = restore(
    {
      // Cast through unknown — `ImportedDataState` is permissive about the
      // exact element/appState shape so our JSON validator's narrower types
      // are fine as inputs.
      elements: safe.elements as never,
      appState: safe.appState as never,
      files: safe.files as never,
    },
    null,
    null,
  );
  return {
    elements: restored.elements,
    appState: restored.appState,
    files: restored.files,
  };
}
