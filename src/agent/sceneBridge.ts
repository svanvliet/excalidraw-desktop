/**
 * Registry of live canvases the AI agent may read / edit (docs/ai-integration.md).
 *
 * App.tsx registers each tab's Excalidraw imperative API when the canvas mounts and
 * unregisters it when the tab closes. The scene tools (sceneTools.ts) and turn
 * bookkeeping (scene/turns.ts) look tabs up here — they never touch React state.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/** The subset of the imperative API the agent tools use (keeps tests' fakes small). */
export type SceneApi = Pick<
  ExcalidrawImperativeAPI,
  | "getSceneElementsIncludingDeleted"
  | "getSceneElements"
  | "getAppState"
  | "getFiles"
  | "updateScene"
  | "scrollToContent"
  | "addFiles"
>;

export interface SceneTab {
  api: SceneApi;
  /** Display title (file name or "Untitled"); read lazily so renames are reflected. */
  title: () => string;
  /** True while this tab is bound to a live session in which we are a viewer. */
  isViewer: () => boolean;
  /** Flag the tab as modified (and schedule autosave) after an agent edit. */
  markDirty: () => void;
}

const tabs = new Map<string, SceneTab>();
let activeTabId: string | null = null;

/** Register (or replace) a tab's canvas. Returns an unregister function. */
export function registerSceneTab(tabId: string, tab: SceneTab): () => void {
  tabs.set(tabId, tab);
  return () => {
    if (tabs.get(tabId) === tab) tabs.delete(tabId);
  };
}

export function unregisterSceneTab(tabId: string): void {
  tabs.delete(tabId);
}

export function getSceneTab(tabId: string): SceneTab | undefined {
  return tabs.get(tabId);
}

export function listSceneTabs(): Array<{ tabId: string; tab: SceneTab }> {
  return [...tabs.entries()].map(([tabId, tab]) => ({ tabId, tab }));
}

export function setActiveSceneTab(tabId: string | null): void {
  activeTabId = tabId;
}

export function getActiveSceneTabId(): string | null {
  return activeTabId && tabs.has(activeTabId) ? activeTabId : null;
}

/** Test helper: drop every registration. */
export function resetSceneBridge(): void {
  tabs.clear();
  activeTabId = null;
}
