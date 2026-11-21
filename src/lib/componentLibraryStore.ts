/**
 * The user's personal, cross-document component library ("My components", FR-55, D-DX10).
 *
 * Stored in `<appData>/components.json` (`components-<profile>.json` under a test profile, see
 * storeFile.ts). Every tab of the app shares this module, so a change made in one tab reaches the
 * others through `subscribeMyComponents`.
 *
 * Rules (same as libraryStore.ts):
 * - Nothing is saved until the stored library has loaded, so an empty initial state can never
 *   overwrite it. If loading fails, saving stays off for the session (logged) so a damaged file
 *   isn't replaced.
 * - Only tabs that may write call the mutators; live-collab guest tabs show the list read-only
 *   (the UI passes `persistLibrary`).
 * - Outside Tauri (browser preview, e2e) the library lives in memory for the session.
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { isTauri } from "../ipc/commands";
import { log } from "./logger";
import { storeFile } from "./storeFile";

const STORE_FILE = "components.json";
const STORE_KEY = "components";
export const MY_COMPONENTS_VERSION = 1;

/** One saved component: a snapshot of a master, normalised so its top-left is at 0,0. */
export interface MyComponent {
  /** The component id; inserting it into a document reuses it, so instances stay linked. */
  id: string;
  name: string;
  /** Master children (tagged `excalidrawDesktop.component`, role "master"). */
  elements: ExcalidrawElement[];
  /** Image files the elements reference. */
  files?: Record<string, BinaryFileData>;
  created: number;
  updated: number;
}

interface PersistedKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

const memoryStore = (): PersistedKV => {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => data.get(k) as T | undefined,
    set: async (k, v) => void data.set(k, v),
    save: async () => {},
  };
};

let storeSingleton: PersistedKV | null = null;
let loadPromise: Promise<void> | null = null;
let loaded = false;
let saveDisabled = false;
let current: readonly MyComponent[] = [];
let writeChain: Promise<void> = Promise.resolve();
const listeners = new Set<(items: readonly MyComponent[]) => void>();

async function getStore(): Promise<PersistedKV> {
  if (!storeSingleton) {
    storeSingleton = isTauri()
      ? (new LazyStore(await storeFile(STORE_FILE)) as unknown as PersistedKV)
      : memoryStore();
  }
  return storeSingleton;
}

export function isMyComponent(v: unknown): v is MyComponent {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Partial<MyComponent>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    Array.isArray(c.elements) &&
    c.elements.length > 0 &&
    c.elements.every((e) => typeof e === "object" && e !== null && typeof e.id === "string") &&
    (c.files === undefined ||
      (typeof c.files === "object" &&
        c.files !== null &&
        Object.values(c.files).every(
          (f) => typeof f?.id === "string" && typeof f.dataURL === "string",
        )))
  );
}

/** Load the stored library once per session. Never rejects: failures resolve to `[]`. */
export function loadMyComponents(): Promise<readonly MyComponent[]> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const store = await getStore();
        const raw = await store.get<unknown>(STORE_KEY);
        if (raw !== undefined && !Array.isArray(raw)) {
          throw new Error("stored component library is not an array");
        }
        const items = ((raw as unknown[] | undefined) ?? []).filter(isMyComponent);
        if (raw && items.length !== (raw as unknown[]).length) {
          log.warn(
            `components: skipped ${(raw as unknown[]).length - items.length} invalid saved component(s)`,
          );
        }
        current = items;
      } catch (err) {
        saveDisabled = true;
        log.warn("components: couldn't load My components; changes won't be saved", err);
        current = [];
      }
      loaded = true;
      notify();
    })();
  }
  // The current list, not the one at load time: later saves replace `current`.
  return loadPromise.then(() => current);
}

/** The library as last loaded or changed (empty before load). */
export function getMyComponents(): readonly MyComponent[] {
  return current;
}

/** True when changes can be saved (loaded, and loading didn't fail). */
export function canSaveMyComponents(): boolean {
  return loaded && !saveDisabled;
}

/** Called with the new list after every change and after loading. Returns an unsubscribe. */
export function subscribeMyComponents(cb: (items: readonly MyComponent[]) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  for (const cb of listeners) {
    try {
      cb(current);
    } catch (err) {
      log.warn("components: a My components listener failed", err);
    }
  }
}

function persist(next: readonly MyComponent[]): Promise<boolean> {
  if (!canSaveMyComponents()) return Promise.resolve(false);
  current = next;
  notify();
  let ok = true;
  writeChain = writeChain.then(async () => {
    try {
      const store = await getStore();
      await store.set(STORE_KEY, next);
      await store.save();
    } catch (err) {
      ok = false;
      log.warn("components: couldn't save My components", err);
    }
  });
  return writeChain.then(() => ok);
}

/**
 * Add a component, or replace the saved one with the same id (keeping its `created` time and
 * list position). Resolves to false when saving is unavailable or the write failed.
 */
export async function putMyComponent(item: MyComponent): Promise<boolean> {
  await loadMyComponents();
  const at = current.findIndex((c) => c.id === item.id);
  if (at < 0) return persist([...current, item]);
  const next = [...current];
  next[at] = { ...item, created: current[at].created };
  return persist(next);
}

export async function renameMyComponent(id: string, name: string): Promise<boolean> {
  await loadMyComponents();
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed || !current.some((c) => c.id === id)) return false;
  return persist(
    current.map((c) => (c.id === id ? { ...c, name: trimmed, updated: Date.now() } : c)),
  );
}

export async function removeMyComponent(id: string): Promise<boolean> {
  await loadMyComponents();
  if (!current.some((c) => c.id === id)) return false;
  return persist(current.filter((c) => c.id !== id));
}

/** For tests only — inject a fake store and reset all state. */
export function __resetMyComponentsForTest(store: PersistedKV | null = null): void {
  storeSingleton = store;
  loadPromise = null;
  loaded = false;
  saveDisabled = false;
  current = [];
  writeChain = Promise.resolve();
  listeners.clear();
}
