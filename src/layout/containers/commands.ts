/**
 * Smart-container commands: the shortcut action and their `run`s. The native Layout menu and the
 * toolbar's Layout dropdown list them via src/layout/commands.json (labels, order) and
 * src/layout/commands.ts (which delegates to `run` here).
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  containerPanelView,
  isMakeContainerShortcut,
  makeContainerFromSelection,
  unmakeContainer,
} from "./host";

type Api = ExcalidrawImperativeAPI;

export interface ContainerCommand {
  /** Excalidraw action name and the native menu id suffix (`excalidraw:layout:<id>`). */
  id: "makeContainer" | "removeContainer";
  label: string;
  /** Display string for menus; matched by `keyTest` in the editor. */
  shortcut?: string;
  keyTest?: (e: KeyboardEvent | React.KeyboardEvent) => boolean;
  enabled(api: Api): boolean;
  run(api: Api): void;
}

function selectionView(api: Api) {
  const sel = api.getAppState().selectedElementIds;
  const scene = api.getSceneElementsIncludingDeleted() as readonly ExcalidrawElement[];
  const selected = scene.filter((e) => sel[e.id] && !e.isDeleted);
  return containerPanelView(scene, selected);
}

export const CONTAINER_COMMANDS: readonly ContainerCommand[] = [
  {
    id: "makeContainer",
    label: "Make container",
    shortcut: "Alt+Shift+A",
    keyTest: isMakeContainerShortcut,
    enabled: (api) => Object.values(api.getAppState().selectedElementIds).some(Boolean),
    run: (api) => void makeContainerFromSelection(api),
  },
  {
    id: "removeContainer",
    label: "Remove container",
    enabled: (api) => selectionView(api)?.mode === "container",
    run: (api) => {
      const view = selectionView(api);
      if (view?.mode === "container" && view.containerId) unmakeContainer(api, view.containerId);
      else api.setToast({ message: "Select a container first." });
    },
  },
];

export const containerMenuId = (c: ContainerCommand) => `excalidraw:layout:${c.id}`;

/** Register the shortcut-bearing commands as Excalidraw actions (editor key routing applies). */
export function registerContainerActions(api: Api): void {
  for (const c of CONTAINER_COMMANDS) {
    if (!c.keyTest) continue;
    const keyTest = c.keyTest;
    api.registerAction({
      name: c.id as never,
      label: c.label,
      trackEvent: false,
      keyTest: (event) => keyTest(event),
      perform: () => {
        c.run(api);
        return false;
      },
    });
  }
}

/** Run a native menu command; returns false if `menuId` isn't a container command. */
export function runContainerMenuCommand(api: Api | undefined, menuId: string): boolean {
  const c = CONTAINER_COMMANDS.find((cmd) => containerMenuId(cmd) === menuId);
  if (!c) return false;
  if (api) c.run(api);
  return true;
}
