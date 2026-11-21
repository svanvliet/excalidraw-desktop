import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Draft, ToolError, revisionOf } from "../agent/scene/draft";
import { commitDraftUndoable } from "../agent/scene/turns";
import { log } from "../lib/logger";
import { autoLayoutDraft, type AutoLayoutOptions } from "./apply";

export type CanvasLayoutPreset = "down" | "right" | "tree";

export const LAYOUT_PRESETS: Record<CanvasLayoutPreset, AutoLayoutOptions> = {
  down: { algorithm: "layered", direction: "down" },
  right: { algorithm: "layered", direction: "right" },
  tree: { algorithm: "tree", direction: "down" },
};

/** Alt/Option+Shift+L. Matched on `code` because Option rewrites `key` on macOS. */
export function isAutoLayoutShortcut(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.code === "KeyL" && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
}

let running = false;

/**
 * The user-facing "Auto-layout" action: lays out the selection (or the whole diagram when
 * nothing is selected) and commits it as a single undo step. Aborts — leaving the canvas
 * untouched — if the user edits the scene while ELK is computing.
 */
export async function autoLayoutCanvas(
  api: ExcalidrawImperativeAPI,
  preset: CanvasLayoutPreset,
): Promise<boolean> {
  if (running) return false;
  const appState = api.getAppState();
  if (appState.viewModeEnabled) return false;
  running = true;
  try {
    const base = api.getSceneElementsIncludingDeleted();
    const draft = new Draft(base);
    const ids = Object.keys(appState.selectedElementIds).filter(
      (id) => appState.selectedElementIds[id],
    );
    const summary = await autoLayoutDraft(draft, { ...LAYOUT_PRESETS[preset], ids });
    if (revisionOf(api.getSceneElementsIncludingDeleted()) !== revisionOf(base)) {
      api.setToast({ message: "The canvas changed during auto-layout; try again." });
      return false;
    }
    if (!draft.changed.size) return true;
    commitDraftUndoable(api, draft);
    log.info(`auto-layout (${preset}): ${summary.nodes} nodes, ${summary.edges} edges`);
    return true;
  } catch (err) {
    if (err instanceof ToolError) {
      api.setToast({ message: err.message });
    } else {
      log.error("auto-layout failed", err);
      api.setToast({ message: "Auto-layout failed. See the log for details." });
    }
    return false;
  } finally {
    running = false;
  }
}
