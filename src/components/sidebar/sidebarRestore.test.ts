import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { DOCKED_SIDEBAR_BREAKPOINT, installSidebarRestore } from "./sidebarRestore";

type AppStateLike = {
  openSidebar: { name: string; tab?: string } | null;
  defaultSidebarDockedPreference: boolean;
};

function setup(width: number) {
  let appState: AppStateLike = {
    openSidebar: { name: "default", tab: "library" },
    defaultSidebarDockedPreference: true,
  };
  const sceneListeners: ((els: unknown, s: AppStateLike) => void)[] = [];
  const panelListeners: ((open: boolean) => void)[] = [];
  let panelOpen = false;
  const updateScene = vi.fn(({ appState: next }: { appState: Partial<AppStateLike> }) => {
    setAppState(next);
  });
  function setAppState(next: Partial<AppStateLike>) {
    appState = { ...appState, ...next };
    sceneListeners.forEach((l) => l([], appState));
  }
  const api = {
    getAppState: () => appState,
    onChange: (l: (els: unknown, s: AppStateLike) => void) => {
      sceneListeners.push(l);
      return () => sceneListeners.splice(sceneListeners.indexOf(l), 1);
    },
    updateScene,
  } as unknown as ExcalidrawImperativeAPI;
  const off = installSidebarRestore(api, {
    panelOpen: () => panelOpen,
    onPanelChange: (cb) => {
      panelListeners.push(cb);
      return () => panelListeners.splice(panelListeners.indexOf(cb), 1);
    },
    editorWidth: () => width,
  });
  const setPanel = (open: boolean) => {
    panelOpen = open;
    panelListeners.forEach((l) => l(open));
  };
  return { setAppState, setPanel, updateScene, off, state: () => appState };
}

describe("installSidebarRestore", () => {
  it("reopens a docked sidebar that closed as an overlay while the AI panel was open", () => {
    const t = setup(DOCKED_SIDEBAR_BREAKPOINT - 100);
    t.setPanel(true);
    t.setAppState({ openSidebar: null });
    t.setPanel(false);
    expect(t.state().openSidebar).toEqual({ name: "default", tab: "library" });
  });

  it("restores a custom tab too", () => {
    const t = setup(DOCKED_SIDEBAR_BREAKPOINT - 100);
    t.setAppState({ openSidebar: { name: "default", tab: "layers" } });
    t.setPanel(true);
    t.setAppState({ openSidebar: null });
    t.setPanel(false);
    expect(t.state().openSidebar).toEqual({ name: "default", tab: "layers" });
  });

  it("leaves the sidebar closed when the user closed it while it was still docked", () => {
    const t = setup(DOCKED_SIDEBAR_BREAKPOINT + 100);
    t.setPanel(true);
    t.setAppState({ openSidebar: null });
    t.setPanel(false);
    expect(t.updateScene).not.toHaveBeenCalled();
    expect(t.state().openSidebar).toBeNull();
  });

  it("does not restore an undocked (overlay) sidebar", () => {
    const t = setup(DOCKED_SIDEBAR_BREAKPOINT - 100);
    t.setAppState({ defaultSidebarDockedPreference: false });
    t.setPanel(true);
    t.setAppState({ openSidebar: null });
    t.setPanel(false);
    expect(t.updateScene).not.toHaveBeenCalled();
  });

  it("stops listening after uninstall", () => {
    const t = setup(DOCKED_SIDEBAR_BREAKPOINT - 100);
    t.off();
    t.setPanel(true);
    t.setAppState({ openSidebar: null });
    t.setPanel(false);
    expect(t.updateScene).not.toHaveBeenCalled();
  });
});
