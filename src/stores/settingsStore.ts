/**
 * User-controlled feature toggles. Every toggle defaults to **off** so a
 * fresh install is completely offline.
 *
 * Persisted to `<appData>/settings.json` (or `settings-<profile>.json`
 * under a test profile) via `tauri-plugin-store`. Stays in-memory only if
 * persistence fails (e.g. in tests), so the UI is always usable.
 *
 * Online toggles:
 * - `collab`     — Live collaboration via the embedded, end-to-end
 *                  encrypted relay (docs/collab-protocol.md). Nothing
 *                  listens or connects until the user starts a session.
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
import type { TunnelMode } from "../ipc/commands";
import { log } from "../lib/logger";
import { storeFile } from "../lib/storeFile";

export interface OnlineFeaturesSettings {
  collab: boolean;
  library: boolean;
  ai: boolean;
}

export interface SecretsSettings {
  openAiKey: string;
}

export interface CollabSettings {
  /** Name shown to other participants. Empty = prompt / fallback. */
  collabDisplayName: string;
  collabTunnelMode: TunnelMode;
  /** Public URL of a user-run tunnel (manual mode only). */
  collabManualUrl: string;
  /** Local relay port (127.0.0.1). */
  collabPort: number;
}

export type AllSettings = OnlineFeaturesSettings & SecretsSettings & CollabSettings;

export interface SettingsState extends AllSettings {
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
  /** Update a live-collaboration preference. */
  setCollab: <K extends keyof CollabSettings>(key: K, value: CollabSettings[K]) => Promise<void>;
  /** Reset every toggle/secret to its default. Useful for tests + "Reset" UI. */
  resetAll: () => Promise<void>;
}

const STORE_FILE = "settings.json";
const STORE_KEY = "settings";

export const DEFAULT_COLLAB_PORT = 4780;

export const SETTINGS_DEFAULTS = {
  collab: false,
  library: false,
  ai: false,
  openAiKey: "",
  collabDisplayName: "",
  collabTunnelMode: "auto",
  collabManualUrl: "",
  collabPort: DEFAULT_COLLAB_PORT,
} as const satisfies AllSettings;
const DEFAULTS: AllSettings = SETTINGS_DEFAULTS;

let lazyStore: LazyStore | null = null;
async function store(): Promise<LazyStore> {
  if (!lazyStore) lazyStore = new LazyStore(await storeFile(STORE_FILE));
  return lazyStore;
}

export function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isTunnelMode(value: unknown): value is TunnelMode {
  return value === "auto" || value === "manual" || value === "local";
}

/**
 * Coerce whatever is on disk into a valid settings object. Unknown keys
 * (including the legacy `firebaseConfig`) are dropped.
 */
export function sanitize(raw: unknown): AllSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    collab: typeof r.collab === "boolean" ? r.collab : DEFAULTS.collab,
    library: typeof r.library === "boolean" ? r.library : DEFAULTS.library,
    ai: typeof r.ai === "boolean" ? r.ai : DEFAULTS.ai,
    openAiKey: typeof r.openAiKey === "string" ? r.openAiKey : DEFAULTS.openAiKey,
    collabDisplayName:
      typeof r.collabDisplayName === "string"
        ? r.collabDisplayName.slice(0, 64)
        : DEFAULTS.collabDisplayName,
    collabTunnelMode: isTunnelMode(r.collabTunnelMode)
      ? r.collabTunnelMode
      : DEFAULTS.collabTunnelMode,
    collabManualUrl: isHttpUrl(r.collabManualUrl) ? r.collabManualUrl : DEFAULTS.collabManualUrl,
    collabPort: isValidPort(r.collabPort) ? r.collabPort : DEFAULTS.collabPort,
  };
}

function snapshot(s: AllSettings): AllSettings {
  return {
    collab: s.collab,
    library: s.library,
    ai: s.ai,
    openAiKey: s.openAiKey,
    collabDisplayName: s.collabDisplayName,
    collabTunnelMode: s.collabTunnelMode,
    collabManualUrl: s.collabManualUrl,
    collabPort: s.collabPort,
  };
}

async function persist(values: AllSettings): Promise<void> {
  try {
    const st = await store();
    await st.set(STORE_KEY, values);
    await st.save();
  } catch (e) {
    // Never block the UI on persistence; surface for debugging.
    log.warn("settingsStore: failed to persist", e);
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  loaded: false,

  async load() {
    try {
      const raw = await (await store()).get<unknown>(STORE_KEY);
      set({ ...sanitize(raw), loaded: true });
    } catch (e) {
      log.warn("settingsStore: failed to load, falling back to defaults", e);
      set({ ...DEFAULTS, loaded: true });
    }
  },

  async setFlag(key, value) {
    set({ [key]: value } as Partial<SettingsState>);
    await persist(snapshot(get()));
  },

  async setSecret(key, value) {
    set({ [key]: value } as Partial<SettingsState>);
    await persist(snapshot(get()));
  },

  async setCollab(key, value) {
    set({ [key]: value } as Partial<SettingsState>);
    // Persist only valid values; in-progress edits (e.g. a half-typed URL)
    // stay in memory and are sanitized away if the app quits mid-edit.
    await persist(sanitize(snapshot(get())));
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
