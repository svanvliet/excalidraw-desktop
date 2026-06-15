/**
 * Multi-document state for the app, backed by Zustand.
 *
 * Each tab represents one open document. A tab carries either a real on-disk
 * path (saved) or no path at all (new untitled document). The full scene
 * lives inside Excalidraw's own component state — the store only tracks the
 * lightweight metadata the UI needs (tab list, active tab, dirty flag, the
 * scene seed to pass to Excalidraw on mount, and the eventual scratch path
 * autosave will write to before the user picks a real one).
 */
import { create } from "zustand";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

export interface Tab {
  id: string;
  /** Absolute path on disk, or null for an untitled document. */
  path: string | null;
  /** Scene to seed Excalidraw with on mount. Cleared after consumption. */
  initialData: ExcalidrawInitialDataState | null;
  /** True when in-memory state differs from what's on disk. */
  dirty: boolean;
}

export interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  selectTab: (id: string) => void;
  newTab: () => string;
  openTab: (path: string, initialData: ExcalidrawInitialDataState) => string;
  markDirty: (id: string) => void;
  markSaved: (id: string, path: string) => void;
  closeTab: (id: string) => void;
  /** Replace the entire tab list — used by session restore. */
  replaceAll: (tabs: Tab[], activeTabId: string | null) => void;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `tab-${Date.now().toString(36)}-${counter}`;
}

/** Reset the internal id counter — for tests only. */
export function __resetIdCounter(): void {
  counter = 0;
}

function emptyTab(): Tab {
  return { id: nextId(), path: null, initialData: null, dirty: false };
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [emptyTab()],
  activeTabId: null,

  selectTab: (id) => {
    if (!get().tabs.some((t) => t.id === id)) return;
    set({ activeTabId: id });
  },

  newTab: () => {
    const tab = emptyTab();
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  openTab: (path, initialData) => {
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    // If the only tab is an untouched blank scratch tab, replace it; otherwise
    // append a new tab so we never silently lose user work.
    const tabs = get().tabs;
    const onlyTab = tabs.length === 1 ? tabs[0] : null;
    if (onlyTab && onlyTab.path === null && !onlyTab.dirty) {
      const replaced: Tab = { ...onlyTab, path, initialData, dirty: false };
      set({ tabs: [replaced], activeTabId: replaced.id });
      return replaced.id;
    }
    const tab: Tab = { id: nextId(), path, initialData, dirty: false };
    set({ tabs: [...tabs, tab], activeTabId: tab.id });
    return tab.id;
  },

  markDirty: (id) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id && !t.dirty ? { ...t, dirty: true } : t)),
    }));
  },

  markSaved: (id, path) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, path, dirty: false } : t)),
    }));
  },

  closeTab: (id) => {
    const tabs = get().tabs.filter((t) => t.id !== id);
    if (tabs.length === 0) {
      const blank = emptyTab();
      set({ tabs: [blank], activeTabId: blank.id });
      return;
    }
    const wasActive = get().activeTabId === id;
    set({
      tabs,
      activeTabId: wasActive ? tabs[tabs.length - 1].id : get().activeTabId,
    });
  },

  replaceAll: (tabs, activeTabId) => {
    if (tabs.length === 0) {
      const blank = emptyTab();
      set({ tabs: [blank], activeTabId: blank.id });
      return;
    }
    const activeStillExists = activeTabId && tabs.some((t) => t.id === activeTabId);
    set({ tabs, activeTabId: activeStillExists ? activeTabId : tabs[0].id });
  },
}));

/**
 * Initialize the active tab on first mount. We can't set `activeTabId` to the
 * initial tab's id at module-evaluation time because that runs before the
 * store's `set` is wired up; this helper completes the bootstrap.
 */
export function ensureActiveTab(): void {
  const { activeTabId, tabs } = useTabsStore.getState();
  if (!activeTabId && tabs.length > 0) {
    useTabsStore.setState({ activeTabId: tabs[0].id });
  }
}
