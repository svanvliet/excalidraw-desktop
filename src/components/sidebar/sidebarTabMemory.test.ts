import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { installSidebarTabMemory, LIBRARY_TAB, reopenTab } from "./sidebarTabMemory";

type OpenSidebar = { name: string; tab?: string } | null;

function setup(initial: OpenSidebar = null) {
  let openSidebar = initial;
  const listeners: ((els: unknown, s: { openSidebar: OpenSidebar }) => void)[] = [];
  const api = {
    getAppState: () => ({ openSidebar }),
    onChange: (l: (els: unknown, s: { openSidebar: OpenSidebar }) => void) => {
      listeners.push(l);
      return () => listeners.splice(listeners.indexOf(l), 1);
    },
  } as unknown as ExcalidrawImperativeAPI;
  const remember = vi.fn();
  const off = installSidebarTabMemory(api, remember);
  const set = (next: OpenSidebar) => {
    openSidebar = next;
    listeners.forEach((l) => l([], { openSidebar }));
  };
  return { set, remember, off };
}

describe("installSidebarTabMemory", () => {
  it("remembers the tab the default sidebar shows, once per change", () => {
    const t = setup();
    t.set({ name: "default", tab: "library" });
    t.set({ name: "default", tab: "components" });
    t.set({ name: "default", tab: "components" });
    t.set(null);
    expect(t.remember.mock.calls).toEqual([["library"], ["components"]]);
  });

  it("ignores the search tab and other sidebars", () => {
    const t = setup();
    t.set({ name: "default", tab: "search" });
    t.set({ name: "custom", tab: "x" });
    t.set({ name: "default" });
    expect(t.remember).not.toHaveBeenCalled();
  });

  it("stops listening when uninstalled", () => {
    const t = setup();
    t.off();
    t.set({ name: "default", tab: "layers" });
    expect(t.remember).not.toHaveBeenCalled();
  });
});

describe("reopenTab", () => {
  it("reopens a known remembered tab, else the library", () => {
    expect(reopenTab("components", ["layers", "components"])).toBe("components");
    expect(reopenTab(LIBRARY_TAB, ["layers"])).toBe(LIBRARY_TAB);
    expect(reopenTab("gone", ["layers"])).toBe(LIBRARY_TAB);
    expect(reopenTab(null, ["layers"])).toBe(LIBRARY_TAB);
  });
});
