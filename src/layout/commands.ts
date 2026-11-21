/**
 * The Layout commands, shared by the native Layout menu (src-tauri/src/menu.rs builds it from
 * commands.json) and the toolbar's Layout dropdown, so the two can't drift.
 *
 * To add a command: append an entry to commands.json (id `excalidraw:layout:<name>`, label,
 * optional display-only shortcut; `{ "separator": true }` for a divider) and its `run` below.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import spec from "./commands.json";
import { autoLayoutCanvas, tidyArrowsCanvas } from "./canvasAction";
import { CONTAINER_COMMANDS, containerMenuId } from "./containers/commands";

export type LayoutCommandId = `excalidraw:layout:${string}`;

export interface LayoutCommand {
  id: LayoutCommandId;
  label: string;
  /** Display only (e.g. "Alt+Shift+L"); the key handling lives with the canvas. */
  shortcut?: string;
  run: (api: ExcalidrawImperativeAPI) => unknown;
}

export type LayoutMenuEntry = LayoutCommand | { separator: true };

const RUN: Record<string, LayoutCommand["run"]> = {
  "excalidraw:layout:down": (api) => autoLayoutCanvas(api, "down"),
  "excalidraw:layout:right": (api) => autoLayoutCanvas(api, "right"),
  "excalidraw:layout:tree": (api) => autoLayoutCanvas(api, "tree"),
  "excalidraw:layout:tidyArrows": (api) => tidyArrowsCanvas(api),
  "excalidraw:layout:tidyArrowsConvert": (api) => tidyArrowsCanvas(api, { convert: true }),
  ...Object.fromEntries(CONTAINER_COMMANDS.map((c) => [containerMenuId(c), c.run])),
};

type SpecEntry = { id?: string; label?: string; shortcut?: string; separator?: boolean };

export const LAYOUT_MENU: readonly LayoutMenuEntry[] = (spec as SpecEntry[]).map((e) => {
  if (e.separator) return { separator: true };
  const run = e.id && RUN[e.id];
  if (!run || !e.label) throw new Error(`Layout command ${e.id ?? "?"} has no label or run`);
  return { id: e.id as LayoutCommandId, label: e.label, shortcut: e.shortcut, run };
});

export const LAYOUT_COMMANDS: readonly LayoutCommand[] = LAYOUT_MENU.filter(
  (e): e is LayoutCommand => !("separator" in e),
);

/** Run a Layout command by id. Returns false for an unknown id. */
export function runLayoutCommand(id: string, api: ExcalidrawImperativeAPI): boolean {
  const cmd = LAYOUT_COMMANDS.find((c) => c.id === id);
  if (!cmd) return false;
  void cmd.run(api);
  return true;
}
