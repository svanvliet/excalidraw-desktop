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
 * - `ai`         — "Bring your own agent" (docs/ai-integration.md): drives
 *                  the user's locally installed, signed-in Copilot CLI /
 *                  Claude Code / Codex. Nothing spawns until a prompt is sent.
 * - `autoUpdate` — Periodic update checks against GitHub Releases.
 *                  `null` means "not asked yet": the first-launch prompt
 *                  sets it, and no check runs until it is `true`.
 *
 * **Secret handling:** the app stores no AI credentials at all (SEC-3,
 * FR-28). The legacy `openAiKey` is dropped by `sanitize()` and scrubbed
 * from `settings.json` on the next persist.
 */
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { TunnelMode } from "../ipc/commands";
import type { EngineKind } from "../agent/types";
import { log } from "../lib/logger";
import { storeFile } from "../lib/storeFile";

export interface OnlineFeaturesSettings {
  collab: boolean;
  library: boolean;
  ai: boolean;
}

export const ENGINE_KINDS: readonly EngineKind[] = ["copilot", "claude", "codex"];

export interface EngineSettings {
  enabled: boolean;
  /** Custom binary path; empty = auto-detect. */
  pathOverride: string;
  /** "Use my agent's MCPs, skills & plugins" (D-AI5, default on). */
  useHostConfig: boolean;
  /** Default model; empty = the engine's own default. */
  model: string;
}

export interface AiSettings {
  aiEngines: Record<EngineKind, EngineSettings>;
  aiDefaultEngine: EngineKind;
  /** First-use privacy disclosure acceptance per engine (FR-33). */
  aiDisclosureAccepted: Record<EngineKind, boolean>;
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

export interface UpdateSettings {
  /** Automatic update checks. `null` = the user hasn't been asked yet. */
  autoUpdate: boolean | null;
}

export type AllSettings = OnlineFeaturesSettings & AiSettings & CollabSettings & UpdateSettings;

export interface SettingsState extends AllSettings {
  loaded: boolean;
  /** Load persisted settings from disk. Idempotent. */
  load: () => Promise<void>;
  /** Toggle one of the online-features booleans. */
  setFlag: <K extends keyof OnlineFeaturesSettings>(
    key: K,
    value: OnlineFeaturesSettings[K],
  ) => Promise<void>;
  /** Patch one engine's AI settings. */
  setEngineSettings: (engine: EngineKind, patch: Partial<EngineSettings>) => Promise<void>;
  setDefaultEngine: (engine: EngineKind) => Promise<void>;
  /** Record that the user accepted the first-use disclosure for an engine. */
  acceptAiDisclosure: (engine: EngineKind) => Promise<void>;
  /** Update a live-collaboration preference. */
  setCollab: <K extends keyof CollabSettings>(key: K, value: CollabSettings[K]) => Promise<void>;
  /** Record the automatic-update consent. */
  setAutoUpdate: (value: boolean) => Promise<void>;
  /** Reset every toggle/secret to its default. Useful for tests + "Reset" UI. */
  resetAll: () => Promise<void>;
}

const STORE_FILE = "settings.json";
const STORE_KEY = "settings";

export const DEFAULT_COLLAB_PORT = 4780;

export const ENGINE_SETTINGS_DEFAULTS: EngineSettings = {
  enabled: true,
  pathOverride: "",
  useHostConfig: true,
  model: "",
};

export const SETTINGS_DEFAULTS = {
  collab: false,
  library: false,
  ai: false,
  aiEngines: {
    copilot: ENGINE_SETTINGS_DEFAULTS,
    claude: ENGINE_SETTINGS_DEFAULTS,
    codex: ENGINE_SETTINGS_DEFAULTS,
  },
  aiDefaultEngine: "copilot",
  aiDisclosureAccepted: { copilot: false, claude: false, codex: false },
  collabDisplayName: "",
  collabTunnelMode: "auto",
  collabManualUrl: "",
  collabPort: DEFAULT_COLLAB_PORT,
  autoUpdate: null,
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

function isEngineKind(value: unknown): value is EngineKind {
  return (ENGINE_KINDS as readonly unknown[]).includes(value);
}

function sanitizeEngine(raw: unknown): EngineSettings {
  const d = ENGINE_SETTINGS_DEFAULTS;
  if (!raw || typeof raw !== "object") return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    pathOverride: typeof r.pathOverride === "string" ? r.pathOverride.slice(0, 1024) : "",
    useHostConfig: typeof r.useHostConfig === "boolean" ? r.useHostConfig : d.useHostConfig,
    model: typeof r.model === "string" ? r.model.slice(0, 128) : "",
  };
}

function perEngine<T>(fn: (engine: EngineKind) => T): Record<EngineKind, T> {
  return { copilot: fn("copilot"), claude: fn("claude"), codex: fn("codex") };
}

function isTunnelMode(value: unknown): value is TunnelMode {
  return value === "auto" || value === "manual" || value === "local";
}

/**
 * Coerce whatever is on disk into a valid settings object. Unknown keys
 * (including the legacy `firebaseConfig` and `openAiKey`) are dropped.
 */
export function sanitize(raw: unknown): AllSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    collab: typeof r.collab === "boolean" ? r.collab : DEFAULTS.collab,
    library: typeof r.library === "boolean" ? r.library : DEFAULTS.library,
    ai: typeof r.ai === "boolean" ? r.ai : DEFAULTS.ai,
    aiEngines: perEngine((e) =>
      sanitizeEngine((r.aiEngines as Record<string, unknown> | undefined)?.[e]),
    ),
    aiDefaultEngine: isEngineKind(r.aiDefaultEngine) ? r.aiDefaultEngine : DEFAULTS.aiDefaultEngine,
    aiDisclosureAccepted: perEngine(
      (e) => (r.aiDisclosureAccepted as Record<string, unknown> | undefined)?.[e] === true,
    ),
    collabDisplayName:
      typeof r.collabDisplayName === "string"
        ? r.collabDisplayName.slice(0, 64)
        : DEFAULTS.collabDisplayName,
    collabTunnelMode: isTunnelMode(r.collabTunnelMode)
      ? r.collabTunnelMode
      : DEFAULTS.collabTunnelMode,
    collabManualUrl: isHttpUrl(r.collabManualUrl) ? r.collabManualUrl : DEFAULTS.collabManualUrl,
    collabPort: isValidPort(r.collabPort) ? r.collabPort : DEFAULTS.collabPort,
    autoUpdate: typeof r.autoUpdate === "boolean" ? r.autoUpdate : DEFAULTS.autoUpdate,
  };
}

function snapshot(s: AllSettings): AllSettings {
  return {
    collab: s.collab,
    library: s.library,
    ai: s.ai,
    aiEngines: s.aiEngines,
    aiDefaultEngine: s.aiDefaultEngine,
    aiDisclosureAccepted: s.aiDisclosureAccepted,
    collabDisplayName: s.collabDisplayName,
    collabTunnelMode: s.collabTunnelMode,
    collabManualUrl: s.collabManualUrl,
    collabPort: s.collabPort,
    autoUpdate: s.autoUpdate,
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
      const clean = sanitize(raw);
      set({ ...clean, loaded: true });
      // SEC-3 migration: scrub the legacy plaintext key from disk right away.
      if (raw && typeof raw === "object" && "openAiKey" in raw) {
        log.info("settingsStore: removing legacy openAiKey from settings.json");
        await persist(clean);
      }
    } catch (e) {
      log.warn("settingsStore: failed to load, falling back to defaults", e);
      set({ ...DEFAULTS, loaded: true });
    }
  },

  async setFlag(key, value) {
    set({ [key]: value } as Partial<SettingsState>);
    await persist(snapshot(get()));
  },

  async setEngineSettings(engine, patch) {
    const aiEngines = { ...get().aiEngines, [engine]: { ...get().aiEngines[engine], ...patch } };
    set({ aiEngines });
    await persist(snapshot(get()));
  },

  async setDefaultEngine(engine) {
    set({ aiDefaultEngine: engine });
    await persist(snapshot(get()));
  },

  async acceptAiDisclosure(engine) {
    set({ aiDisclosureAccepted: { ...get().aiDisclosureAccepted, [engine]: true } });
    await persist(snapshot(get()));
  },

  async setCollab(key, value) {
    set({ [key]: value } as Partial<SettingsState>);
    // Persist only valid values; in-progress edits (e.g. a half-typed URL)
    // stay in memory and are sanitized away if the app quits mid-edit.
    await persist(sanitize(snapshot(get())));
  },

  async setAutoUpdate(value) {
    set({ autoUpdate: value });
    await persist(snapshot(get()));
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
