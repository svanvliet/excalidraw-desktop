/**
 * Keeps a pinned sidebar pinned across the AI panel (FR-62, D-DX16).
 *
 * Excalidraw docks the sidebar only while the editor is wider than `dockedSidebarBreakpoint`.
 * Below it the sidebar becomes an overlay that closes on any outside click, so opening the AI
 * panel (which narrows the editor) and clicking in it used to drop a pinned Library. We lower
 * the breakpoint, and for windows still too narrow we reopen the sidebar when the AI panel closes.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/** Editor width (px) above which the sidebar stays docked; Excalidraw's default is 1229. */
export const DOCKED_SIDEBAR_BREAKPOINT = 760;

export const SIDEBAR_UI_OPTIONS = { dockedSidebarBreakpoint: DOCKED_SIDEBAR_BREAKPOINT } as const;

type OpenSidebar = ReturnType<ExcalidrawImperativeAPI["getAppState"]>["openSidebar"];

export interface SidebarRestoreDeps {
  /** Whether the AI panel is open right now. */
  panelOpen: () => boolean;
  /** Calls `cb(open)` whenever the AI panel opens or closes; returns an unsubscribe. */
  onPanelChange: (cb: (open: boolean) => void) => () => void;
  /** Current editor width in px. */
  editorWidth: () => number;
}

/**
 * Remembers a docked sidebar that Excalidraw closed as an overlay while the AI panel was open,
 * and reopens it when the panel closes. A sidebar the user closes while it is still docked
 * (editor wide enough) is left closed.
 */
export function installSidebarRestore(
  api: ExcalidrawImperativeAPI,
  deps: SidebarRestoreDeps,
): () => void {
  let last: OpenSidebar = api.getAppState().openSidebar;
  let pending: OpenSidebar = null;

  const offScene = api.onChange((_elements, appState) => {
    const cur = appState.openSidebar;
    if (cur) {
      pending = null;
    } else if (
      last &&
      deps.panelOpen() &&
      appState.defaultSidebarDockedPreference &&
      deps.editorWidth() <= DOCKED_SIDEBAR_BREAKPOINT
    ) {
      pending = last;
    }
    last = cur;
  });

  const offPanel = deps.onPanelChange((open) => {
    if (open || !pending) return;
    const restore = pending;
    pending = null;
    if (!api.getAppState().openSidebar) api.updateScene({ appState: { openSidebar: restore } });
  });

  return () => {
    offScene();
    offPanel();
  };
}
