import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Draft, ToolError, revisionOf } from "../agent/scene/draft";
import { commitDraftUndoable } from "../agent/scene/turns";
import { log } from "../lib/logger";
import { isElbowArrow } from "../lib/elbowAnchors";
import { autoLayoutDraft, type AutoLayoutOptions } from "./apply";
import { tidyArrowsDraft, type TidyOptions } from "./tidy";

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
    tidyAfterLayout(draft);
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

/**
 * Route the elbow arrows auto-layout left for Excalidraw around the other shapes too (keeping
 * the along-flow sides it pinned). Any the router can't fit stay on Excalidraw's re-route.
 */
function tidyAfterLayout(draft: Draft): void {
  const ids = [...draft.reroute].filter((id) => {
    const el = draft.get(id);
    return !!el && isElbowArrow(el);
  });
  if (!ids.length) return;
  try {
    tidyArrowsDraft(draft, { ids });
  } catch (err) {
    if (!(err instanceof ToolError)) log.warn("auto-layout: tidying elbow arrows failed", err);
  }
}

/**
 * The user-facing "Tidy Arrows" action: re-routes the selected arrows (and those bound to selected
 * shapes), or every arrow when nothing is selected, around the other shapes as one undo step.
 */
export function tidyArrowsCanvas(
  api: ExcalidrawImperativeAPI,
  opts: Pick<TidyOptions, "convert"> = {},
): boolean {
  const appState = api.getAppState();
  if (appState.viewModeEnabled) return false;
  try {
    const draft = new Draft(api.getSceneElementsIncludingDeleted());
    const ids = Object.keys(appState.selectedElementIds).filter(
      (id) => appState.selectedElementIds[id],
    );
    const summary = tidyArrowsDraft(draft, { ...opts, ids });
    if (draft.changed.size) commitDraftUndoable(api, draft);
    log.info(
      `tidy arrows: ${summary.routed.length} routed, ${summary.skipped.length} skipped, ` +
        `${summary.converted.length} converted`,
    );
    if (!summary.routed.length) {
      api.setToast({ message: "Couldn't find a clear route for those arrows." });
    } else if (summary.skipped.length) {
      api.setToast({
        message: `Tidied ${summary.routed.length} arrows; ${summary.skipped.length} had no clear route.`,
      });
    }
    return summary.routed.length > 0;
  } catch (err) {
    if (err instanceof ToolError) {
      api.setToast({ message: err.message });
    } else {
      log.error("tidy arrows failed", err);
      api.setToast({ message: "Tidy Arrows failed. See the log for details." });
    }
    return false;
  }
}
