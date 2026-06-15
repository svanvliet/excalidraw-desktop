import { describe, it, expect, beforeEach } from "vitest";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { useTabsStore, ensureActiveTab, __resetIdCounter } from "./tabsStore";

function emptyScene(): ExcalidrawInitialDataState {
  return { elements: [], appState: {}, files: {} };
}

beforeEach(() => {
  __resetIdCounter();
  // Reset to a single blank tab matching the module's initial state.
  useTabsStore.setState({
    tabs: [{ id: "boot", path: null, initialData: null, dirty: false }],
    activeTabId: null,
  });
});

describe("tabsStore", () => {
  describe("ensureActiveTab", () => {
    it("selects the only tab if activeTabId is null", () => {
      ensureActiveTab();
      expect(useTabsStore.getState().activeTabId).toBe("boot");
    });
  });

  describe("newTab", () => {
    it("appends a tab and makes it active", () => {
      const id = useTabsStore.getState().newTab();
      const { tabs, activeTabId } = useTabsStore.getState();
      expect(tabs).toHaveLength(2);
      expect(tabs[1].id).toBe(id);
      expect(activeTabId).toBe(id);
    });
  });

  describe("openTab", () => {
    it("replaces the lone blank tab when opening a file into an untouched session", () => {
      const id = useTabsStore.getState().openTab("/tmp/a.excalidraw", emptyScene());
      const { tabs, activeTabId } = useTabsStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0].id).toBe(id);
      expect(tabs[0].path).toBe("/tmp/a.excalidraw");
      expect(activeTabId).toBe(id);
    });

    it("focuses an existing tab if the same path is already open", () => {
      const first = useTabsStore.getState().openTab("/tmp/a.excalidraw", emptyScene());
      const second = useTabsStore.getState().openTab("/tmp/a.excalidraw", emptyScene());
      expect(first).toBe(second);
      expect(useTabsStore.getState().tabs).toHaveLength(1);
    });

    it("appends a new tab when the blank tab is dirty (don't drop user work)", () => {
      useTabsStore.getState().markDirty("boot");
      const id = useTabsStore.getState().openTab("/tmp/a.excalidraw", emptyScene());
      const { tabs, activeTabId } = useTabsStore.getState();
      expect(tabs).toHaveLength(2);
      expect(activeTabId).toBe(id);
    });
  });

  describe("markDirty / markSaved", () => {
    it("flips dirty true and clears it on save", () => {
      useTabsStore.getState().markDirty("boot");
      expect(useTabsStore.getState().tabs[0].dirty).toBe(true);
      useTabsStore.getState().markSaved("boot", "/tmp/x.excalidraw");
      expect(useTabsStore.getState().tabs[0]).toMatchObject({
        path: "/tmp/x.excalidraw",
        dirty: false,
      });
    });

    it("markDirty is idempotent — second call doesn't allocate a new tab object", () => {
      useTabsStore.getState().markDirty("boot");
      const tab = useTabsStore.getState().tabs[0];
      useTabsStore.getState().markDirty("boot");
      expect(useTabsStore.getState().tabs[0]).toBe(tab);
    });
  });

  describe("closeTab", () => {
    it("removes the tab and selects the rightmost remaining tab", () => {
      const second = useTabsStore.getState().newTab();
      const third = useTabsStore.getState().newTab();
      useTabsStore.getState().selectTab(third);
      useTabsStore.getState().closeTab(third);
      expect(useTabsStore.getState().tabs.map((t) => t.id)).toEqual(["boot", second]);
      expect(useTabsStore.getState().activeTabId).toBe(second);
    });

    it("replaces the last tab with a fresh blank when closing the only tab", () => {
      useTabsStore.getState().closeTab("boot");
      const { tabs, activeTabId } = useTabsStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0].path).toBeNull();
      expect(activeTabId).toBe(tabs[0].id);
    });
  });

  describe("replaceAll", () => {
    it("replaces the entire tab list and validates the active tab id", () => {
      useTabsStore.getState().replaceAll(
        [
          { id: "x", path: "/p/x.excalidraw", initialData: null, dirty: false },
          { id: "y", path: "/p/y.excalidraw", initialData: null, dirty: false },
        ],
        "y",
      );
      const { tabs, activeTabId } = useTabsStore.getState();
      expect(tabs).toHaveLength(2);
      expect(activeTabId).toBe("y");
    });

    it("falls back to the first tab when the requested active id no longer exists", () => {
      useTabsStore
        .getState()
        .replaceAll(
          [{ id: "x", path: "/p/x.excalidraw", initialData: null, dirty: false }],
          "missing",
        );
      expect(useTabsStore.getState().activeTabId).toBe("x");
    });

    it("creates a blank tab when handed an empty list", () => {
      useTabsStore.getState().replaceAll([], null);
      const { tabs } = useTabsStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0].path).toBeNull();
    });
  });
});
