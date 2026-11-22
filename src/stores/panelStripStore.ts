/**
 * Which row of the properties-panel strip is open (FR-63, D-DX17): a single-open accordion keyed
 * by section id, shared by every editor. The choice is remembered with the settings
 * (`panelStripOpen`), so the row you last opened opens again whenever it applies to the
 * selection. Default: everything collapsed.
 */
import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";

interface PanelStripState {
  open: string | null;
  setOpen(id: string | null): void;
  /** Opens `id` (closing any other) or closes it if it is the open one. */
  toggle(id: string): void;
}

export const usePanelStripStore = create<PanelStripState>((set, get) => ({
  open: useSettingsStore.getState().panelStripOpen,
  setOpen(id) {
    if (get().open === id) return;
    set({ open: id });
    void useSettingsStore.getState().setPanelStripOpen(id);
  },
  toggle(id) {
    get().setOpen(get().open === id ? null : id);
  },
}));

// Settings load after startup (and can be reset): follow them.
useSettingsStore.subscribe((s, prev) => {
  if (
    s.panelStripOpen !== prev.panelStripOpen &&
    s.panelStripOpen !== usePanelStripStore.getState().open
  ) {
    usePanelStripStore.setState({ open: s.panelStripOpen });
  }
});
