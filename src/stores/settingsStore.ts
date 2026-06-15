/**
 * User-controlled feature toggles. Every toggle defaults to **off** so a
 * fresh install is completely offline.
 *
 * Persisted to `<appData>/settings.json` via `tauri-plugin-store`. Stays
 * in-memory only if persistence fails (e.g. in tests), so the UI is
 * always usable.
 *
 * Online toggles:
 * - `collab`     — Excalidraw realtime collaboration (Firebase).
 * - `library`    — Opens the public Excalidraw libraries site in the
 *                  system browser. No in-app webview is loaded.
 * - `ai`         — Excalidraw's text-to-diagram AI panel; requires the
 *                  user to supply their own OpenAI key.
 *
 * **Secret handling:** for v1 we persist the OpenAI key alongside the
 * other settings in plain `settings.json`. A loud warning is shown in
 * the Settings dialog. Native-keychain integration is tracked as
 * post-v1 work (see `docs/plan.md` §M6 follow-ups).
 */
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";

export interface OnlineFeaturesSettings {
  collab: boolean;
  library: boolean;
  ai: boolean;
}

export interface SecretsSettings {
  openAiKey: string;
  /** Firebase config JSON used by collab. Empty string disables. */
  firebaseConfig: string;
}

export interface SettingsState extends OnlineFeaturesSettings, SecretsSettings {
  loaded: boolean;
  /** Load persisted settings from disk. Idempotent. */
  load: () => Promise<void>;
  /** Toggle one of the online-features booleans. */
  setFlag: <K extends keyof OnlineFeaturesSettings>(
    key: K,
    value: OnlineFeaturesSettings[K],
  ) => Promise<void>;
  /** Update a secret. */
  setSecret: <K extends keyof SecretsSettings>(key: K, value: SecretsSettings[K]) => Promise<void>;
  /** Reset every toggle/secret to its default. Useful for tests + "Reset" UI. */
  resetAll: () => Promise<void>;
}

const STORE_FILE = "settings.json";
const STORE_KEY = "settings";

const DEFAULTS = {
  collab: false,
  library: false,
  ai: false,
  openAiKey: "",
  firebaseConfig: "",
} as const satisfies OnlineFeaturesSettings & SecretsSettings;

let lazyStore: LazyStore | null = null;
function store(): LazyStore {
  if (!lazyStore) lazyStore = new LazyStore(STORE_FILE);
  return lazyStore;
}

interface PersistedSettings {
  collab?: boolean;
  library?: boolean;
  ai?: boolean;
  openAiKey?: string;
  firebaseConfig?: string;
}

function sanitize(raw: PersistedSettings | undefined): OnlineFeaturesSettings & SecretsSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  return {
    collab: typeof raw.collab === "boolean" ? raw.collab : DEFAULTS.collab,
    library: typeof raw.library === "boolean" ? raw.library : DEFAULTS.library,
    ai: typeof raw.ai === "boolean" ? raw.ai : DEFAULTS.ai,
    openAiKey: typeof raw.openAiKey === "string" ? raw.openAiKey : DEFAULTS.openAiKey,
    firebaseConfig:
      typeof raw.firebaseConfig === "string" ? raw.firebaseConfig : DEFAULTS.firebaseConfig,
  };
}

async function persist(values: OnlineFeaturesSettings & SecretsSettings): Promise<void> {
  try {
    await store().set(STORE_KEY, values);
    await store().save();
  } catch (e) {
    // Never block the UI on persistence; surface for debugging.
    console.warn("settingsStore: failed to persist", e);
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  loaded: false,

  async load() {
    try {
      const raw = await store().get<PersistedSettings>(STORE_KEY);
      set({ ...sanitize(raw), loaded: true });
    } catch (e) {
      console.warn("settingsStore: failed to load, falling back to defaults", e);
      set({ ...DEFAULTS, loaded: true });
    }
  },

  async setFlag(key, value) {
    set({ [key]: value } as Partial<SettingsState>);
    const s = get();
    await persist({
      collab: s.collab,
      library: s.library,
      ai: s.ai,
      openAiKey: s.openAiKey,
      firebaseConfig: s.firebaseConfig,
    });
  },

  async setSecret(key, value) {
    set({ [key]: value } as Partial<SettingsState>);
    const s = get();
    await persist({
      collab: s.collab,
      library: s.library,
      ai: s.ai,
      openAiKey: s.openAiKey,
      firebaseConfig: s.firebaseConfig,
    });
  },

  async resetAll() {
    set({ ...DEFAULTS });
    await persist({ ...DEFAULTS });
  },
}));

/** Exported for tests to clear in-memory state between cases. */
export function __resetSettingsForTests(): void {
  useSettingsStore.setState({ ...DEFAULTS, loaded: false });
  lazyStore = null;
}
