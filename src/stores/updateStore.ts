/**
 * Auto-update state + schedule (Rust side: src-tauri/src/updater.rs).
 *
 * The schedule lives here so the user's `autoUpdate` consent is the only
 * gate: background checks run ~20 s after launch and every 6 h, and only
 * while `autoUpdate === true`. A manual "Check for Updates…" always works.
 * Rust downloads + verifies in the background; installing waits for the
 * user to click "Restart to update".
 */
import { create } from "zustand";
import {
  UPDATE_STATE_UNAVAILABLE,
  updateCheck,
  updateInstall,
  updateStatus,
  type UpdateState,
} from "../ipc/commands";
import { onUpdateStatus } from "../ipc/updateEvents";
import { log } from "../lib/logger";
import { useSettingsStore } from "./settingsStore";

export const FIRST_CHECK_DELAY_MS = 20_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateStoreState extends UpdateState {
  /** "Later" hides the ready banner for this version. */
  dismissedVersion: string | null;
  init: () => Promise<() => void>;
  checkNow: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
  ...UPDATE_STATE_UNAVAILABLE,
  dismissedVersion: null,

  async init() {
    let unlisten: () => void = () => {};
    try {
      unlisten = await onUpdateStatus((s) => set(s));
      set(await updateStatus());
    } catch (e) {
      log.warn("updateStore: status unavailable", e);
    }
    return unlisten;
  },

  async checkNow(manual = true) {
    try {
      set(await updateCheck(manual));
    } catch (e) {
      log.warn("updateStore: check failed", e);
    }
  },

  async install() {
    try {
      await updateInstall();
    } catch (e) {
      // Rust already published the error state; this is for the log.
      log.error("updateStore: install failed", e);
    }
  },

  dismiss() {
    set({ dismissedVersion: get().version });
  },
}));

/** True when a downloaded update should be offered to the user. */
export function selectShowReady(s: UpdateStoreState): boolean {
  return (
    (s.status === "ready" || s.status === "installing") &&
    s.version !== null &&
    s.dismissedVersion !== s.version
  );
}

/**
 * Run background checks while `autoUpdate` is on. Reacts to the setting
 * changing at runtime. Returns a stop function.
 */
export function startUpdateScheduler(
  opts: { firstDelayMs?: number; intervalMs?: number } = {},
): () => void {
  const firstDelay = opts.firstDelayMs ?? FIRST_CHECK_DELAY_MS;
  const interval = opts.intervalMs ?? CHECK_INTERVAL_MS;
  let first: ReturnType<typeof setTimeout> | null = null;
  let repeat: ReturnType<typeof setInterval> | null = null;

  const tick = () => void useUpdateStore.getState().checkNow(false);
  const stop = () => {
    if (first) clearTimeout(first);
    if (repeat) clearInterval(repeat);
    first = repeat = null;
  };
  const sync = (on: boolean) => {
    if (!on) return stop();
    if (first || repeat) return;
    first = setTimeout(() => {
      first = null;
      tick();
      repeat = setInterval(tick, interval);
    }, firstDelay);
  };

  sync(useSettingsStore.getState().autoUpdate === true);
  const unsubscribe = useSettingsStore.subscribe((s, prev) => {
    if (s.autoUpdate !== prev.autoUpdate) sync(s.autoUpdate === true);
  });
  return () => {
    unsubscribe();
    stop();
  };
}

/** Exported for tests. */
export function __resetUpdateStoreForTests(): void {
  useUpdateStore.setState({ ...UPDATE_STATE_UNAVAILABLE, dismissedVersion: null });
}
