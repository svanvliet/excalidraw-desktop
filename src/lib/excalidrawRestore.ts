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
 * `restore()` from `@excalidraw/excalidraw` re-instantiates fields from
 * the default appState **only when the supplied value is `undefined`** —
 * a corrupted `collaborators: {}` would pass straight through. So we
 * pre-strip the known runtime-only keys before delegating to `restore()`,
 * which then falls back to the default `new Map()`.
 */
import { restore } from "@excalidraw/excalidraw";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

/**
 * Keys in `appState` that are either runtime-only or known to hold types
 * that don't survive a JSON round-trip (Map, Set, class instances). We
 * strip them on import so Excalidraw's `restore()` rebuilds the defaults.
 *
 * If you add a feature that depends on persisting one of these, you'll
 * need a custom (de)serializer for it — `JSON.stringify` alone is wrong.
 */
const RUNTIME_ONLY_APPSTATE_KEYS = [
  "collaborators", // Map<string, Collaborator>
  "selectedElementsAreBeingDragged",
  "isResizing",
  "isRotating",
  "isLoading",
  "errorMessage",
  "draggingElement",
  "editingElement",
  "resizingElement",
  "multiElement",
  "selectionElement",
  "newElement",
  "editingTextElement",
  "snapLines",
  "originSnapOffset",
  "contextMenu",
  "showWelcomeScreen",
  "toast",
  "pasteDialog",
  "pendingImageElementId",
] as const;

/** Parsed shape of an `.excalidraw` JSON file (only the keys we care about). */
export interface ImportedSceneLike {
  elements?: unknown;
  appState?: unknown;
  files?: unknown;
}

/** Drop any runtime-only keys from the supplied appState (immutable). */
export function sanitizeImportedAppState(appState: unknown): Record<string, unknown> {
  if (!appState || typeof appState !== "object") return {};
  const out: Record<string, unknown> = { ...(appState as Record<string, unknown>) };
  for (const key of RUNTIME_ONLY_APPSTATE_KEYS) {
    delete out[key];
  }
  return out;
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
  const safe = imported ?? {};
  const restored = restore(
    {
      elements: safe.elements as never,
      appState: sanitizeImportedAppState(safe.appState) as never,
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
