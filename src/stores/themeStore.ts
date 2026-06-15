/**
 * Theme store: `system` | `light` | `dark`.
 *
 * The user-facing preference is persisted; the **resolved** theme
 * (always `light` or `dark`) is what we apply to <html data-theme>
 * and what we pass to Excalidraw via its `theme` prop.
 *
 * `system` watches `prefers-color-scheme` and updates the resolved
 * theme live when the OS swaps appearance.
 *
 * Persistence is via the same `tauri-plugin-store` pattern as
 * settingsStore. Failure to persist never blocks the UI.
 */
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import { log } from "../lib/logger";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  loaded: boolean;
  /** Load persisted mode + start watching system preference. Idempotent. */
  load: () => Promise<void>;
  /** Set the user preference. Returns once the resolved theme is applied. */
  setMode: (mode: ThemeMode) => Promise<void>;
  /** Cycle system → light → dark → system. Used by the toolbar toggle. */
  cycle: () => Promise<void>;
}

const STORE_FILE = "settings.json";
const STORE_KEY = "theme";
const DEFAULT_MODE: ThemeMode = "system";

let lazyStore: LazyStore | null = null;
function store(): LazyStore {
  if (!lazyStore) lazyStore = new LazyStore(STORE_FILE);
  return lazyStore;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function detectSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolve(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? detectSystemTheme() : mode;
}

function applyToDom(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * Singleton listener wiring. We only attach once; the listener flips
 * the resolved theme whenever the OS appearance changes AND the user is
 * still in `system` mode.
 */
let systemListenerAttached = false;
function attachSystemListener(): void {
  if (systemListenerAttached || typeof window === "undefined") return;
  if (typeof window.matchMedia !== "function") return;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    const { mode } = useThemeStore.getState();
    if (mode !== "system") return;
    const resolved = detectSystemTheme();
    useThemeStore.setState({ resolved });
    applyToDom(resolved);
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handler);
  } else if (typeof mq.addListener === "function") {
    // Safari < 14
    mq.addListener(handler);
  }
  systemListenerAttached = true;
}

async function persist(mode: ThemeMode): Promise<void> {
  try {
    await store().set(STORE_KEY, mode);
    await store().save();
  } catch (e) {
    log.warn("themeStore: failed to persist", e);
  }
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: DEFAULT_MODE,
  resolved: resolve(DEFAULT_MODE),
  loaded: false,

  async load() {
    attachSystemListener();
    try {
      const raw = await store().get<unknown>(STORE_KEY);
      const mode: ThemeMode = isThemeMode(raw) ? raw : DEFAULT_MODE;
      const resolved = resolve(mode);
      set({ mode, resolved, loaded: true });
      applyToDom(resolved);
      log.info(`themeStore: loaded mode=${mode} resolved=${resolved}`);
    } catch (e) {
      log.warn("themeStore: failed to load, falling back to system", e);
      const resolved = resolve(DEFAULT_MODE);
      set({ mode: DEFAULT_MODE, resolved, loaded: true });
      applyToDom(resolved);
    }
  },

  async setMode(mode) {
    const resolved = resolve(mode);
    set({ mode, resolved });
    applyToDom(resolved);
    await persist(mode);
  },

  async cycle() {
    const order: ThemeMode[] = ["system", "light", "dark"];
    const current = get().mode;
    const next = order[(order.indexOf(current) + 1) % order.length];
    await get().setMode(next);
  },
}));

/** Exported for tests to clear in-memory state between cases. */
export function __resetThemeForTests(): void {
  useThemeStore.setState({
    mode: DEFAULT_MODE,
    resolved: resolve(DEFAULT_MODE),
    loaded: false,
  });
  lazyStore = null;
  systemListenerAttached = false;
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-theme");
  }
}
