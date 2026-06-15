/**
 * Persisted list of recently opened files.
 *
 * Backed by tauri-plugin-store under the key "recent.files" — the JSON file
 * lives in the OS-specific app-data dir (e.g.
 * ~/Library/Application Support/com.svanvliet.excalidrawdesktop on macOS).
 *
 * The list is most-recent-first, deduped, capped at MAX_RECENT.
 */
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";

const STORE_FILE = "recent-files.json";
const STORE_KEY = "paths";
export const MAX_RECENT = 20;

/** Pure list-manipulation helper. Exposed for unit tests. */
export function pushRecent(existing: readonly string[], path: string, max = MAX_RECENT): string[] {
  if (!path) return [...existing];
  const filtered = existing.filter((p) => p !== path);
  return [path, ...filtered].slice(0, max);
}

/** Pure list-manipulation helper for removing a path. */
export function removeRecent(existing: readonly string[], path: string): string[] {
  return existing.filter((p) => p !== path);
}

/**
 * Minimal interface — the parts of tauri-plugin-store's Store/LazyStore that
 * we actually use. Avoids leaking the plugin's concrete classes (LazyStore is
 * structurally distinct from Store but they share the methods we care about)
 * and lets tests swap in plain objects.
 */
interface PersistedKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

let storeSingleton: PersistedKV | null = null;

/** Open (or reuse) the persisted store. Lazy so tests can swap it out. */
async function getStore(): Promise<PersistedKV> {
  if (!storeSingleton) {
    storeSingleton = new LazyStore(STORE_FILE) as unknown as PersistedKV;
  }
  return storeSingleton;
}

/** For tests only — inject a fake store and reset the in-memory list. */
export function __setStoreForTest(store: PersistedKV | null): void {
  storeSingleton = store;
}

export interface RecentFilesState {
  paths: string[];
  load: () => Promise<void>;
  add: (path: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  clear: () => Promise<void>;
}

export const useRecentFilesStore = create<RecentFilesState>((set, get) => ({
  paths: [],

  async load() {
    const store = await getStore();
    const raw = await store.get<string[]>(STORE_KEY);
    set({ paths: Array.isArray(raw) ? raw.slice(0, MAX_RECENT) : [] });
  },

  async add(path) {
    const next = pushRecent(get().paths, path);
    set({ paths: next });
    const store = await getStore();
    await store.set(STORE_KEY, next);
    await store.save();
  },

  async remove(path) {
    const next = removeRecent(get().paths, path);
    set({ paths: next });
    const store = await getStore();
    await store.set(STORE_KEY, next);
    await store.save();
  },

  async clear() {
    set({ paths: [] });
    const store = await getStore();
    await store.set(STORE_KEY, []);
    await store.save();
  },
}));
