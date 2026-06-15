/**
 * PNG export with embedded Excalidraw scene + PNG read.
 *
 * Round-trip:
 * - exportSceneAsPng: builds a PNG Blob via Excalidraw's exportToBlob,
 *   forcing appState.exportEmbedScene = true so the scene survives.
 * - loadScenePng: takes raw bytes, wraps them in a Blob, calls
 *   loadFromBlob to extract the embedded scene.
 *
 * Kept thin and testable; the actual IPC write is in App.tsx so file-system
 * concerns stay outside the data-transform layer.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

import { exportToBlob, loadFromBlob } from "@excalidraw/excalidraw";

/** Produce a PNG Blob with the current scene embedded as a tEXt chunk. */
export async function exportSceneAsPng(api: ExcalidrawImperativeAPI): Promise<Blob> {
  const appState = api.getAppState() as unknown as Record<string, unknown>;
  return exportToBlob({
    elements: api.getSceneElements(),
    // exportEmbedScene flips Excalidraw's PNG writer into "embed JSON" mode.
    appState: { ...appState, exportEmbedScene: true } as never,
    files: api.getFiles(),
    mimeType: "image/png",
  });
}

/** Convert raw PNG bytes into an ExcalidrawInitialDataState. */
export async function loadScenePng(bytes: Uint8Array): Promise<ExcalidrawInitialDataState | null> {
  const blob = new Blob([bytes], { type: "image/png" });
  try {
    const restored = await loadFromBlob(blob, null, null);
    return {
      elements: restored.elements,
      appState: restored.appState as unknown as ExcalidrawInitialDataState["appState"],
      files: restored.files as unknown as ExcalidrawInitialDataState["files"],
    };
  } catch {
    return null;
  }
}
