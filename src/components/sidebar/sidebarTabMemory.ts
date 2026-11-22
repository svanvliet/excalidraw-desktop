/**
 * Remembers the default sidebar's last tab (FR-68, D-DX22) so the Library button reopens the
 * sidebar where the user left it (e.g. Components) instead of always on Excalidraw's Library tab.
 * The choice is saved with the settings (`sidebarTab`), so it also survives restarts.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

// Excalidraw's DEFAULT_SIDEBAR name and LIBRARY_SIDEBAR_TAB / CANVAS_SEARCH_TAB ids (not exported).
const DEFAULT_SIDEBAR = "default";
export const LIBRARY_TAB = "library";
const SEARCH_TAB = "search";

/**
 * Calls `remember(tab)` whenever the default sidebar switches to a new tab. Search is skipped:
 * it is opened by its own shortcut, not by the Library button.
 */
export function installSidebarTabMemory(
  api: ExcalidrawImperativeAPI,
  remember: (tab: string) => void,
): () => void {
  let last: string | undefined = api.getAppState().openSidebar?.tab;
  return api.onChange((_elements, appState) => {
    const s = appState.openSidebar;
    if (s?.name !== DEFAULT_SIDEBAR || !s.tab || s.tab === last) return;
    last = s.tab;
    if (s.tab !== SEARCH_TAB) remember(s.tab);
  });
}

/** The tab the Library button opens: the remembered one if it still exists, else the library. */
export function reopenTab(remembered: string | null, appTabs: readonly string[]): string {
  return remembered && appTabs.includes(remembered) ? remembered : LIBRARY_TAB;
}
