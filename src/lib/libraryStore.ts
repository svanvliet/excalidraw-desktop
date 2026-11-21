/**
 * The user's personal Excalidraw library ("My library"), persisted across launches (FR-49).
 *
 * Excalidraw keeps the library in memory per editor instance and reports every change through
 * `onLibraryChange`. We store it in `<appData>/library.json` (`library-<profile>.json` under a
 * test profile, see storeFile.ts) and keep every open tab's editor in sync: a change in one tab
 * is saved and pushed to the others with `updateLibrary`.
 *
 * Rules:
 * - Nothing is saved until the stored library has loaded, so an editor's initial empty library
 *   can never overwrite it. If loading fails, saving stays off for the session (logged) so a
 *   damaged file isn't replaced.
 * - Only canvases that opt in write here; live-collab guest tabs and the browser guest app don't.
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import type { LibraryItems } from "@excalidraw/excalidraw/types";
import { log } from "./logger";
import { storeFile } from "./storeFile";

const STORE_FILE = "library.json";
const STORE_KEY = "libraryItems";

interface PersistedKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

/** An editor that shows the library: receives changes made in other tabs. */
export interface LibrarySink {
  updateLibrary(opts: { libraryItems: LibraryItems; merge?: boolean }): Promise<LibraryItems>;
}

let storeSingleton: PersistedKV | null = null;
let loadPromise: Promise<LibraryItems> | null = null;
let loaded = false;
let saveDisabled = false;
let current: LibraryItems = [];
let currentHash = "";
let writeChain: Promise<void> = Promise.resolve();
const sinks = new Set<LibrarySink>();

async function getStore(): Promise<PersistedKV> {
  if (!storeSingleton) {
    storeSingleton = new LazyStore(await storeFile(STORE_FILE)) as unknown as PersistedKV;
  }
  return storeSingleton;
}

/**
 * Cheap, order-sensitive fingerprint of a library: item identity, metadata and element versions.
 * Excalidraw re-clones items on every notification, so object identity can't be used.
 */
export function libraryHash(items: readonly unknown[]): string {
  return items
    .map((raw) => {
      const it = raw as {
        id?: string;
        status?: string;
        name?: string;
        created?: number;
        elements?: ReadonlyArray<{ id?: string; version?: number; isDeleted?: boolean }>;
      };
      const els = (it.elements ?? []).map((e) => `${e.id}.${e.version}${e.isDeleted ? "d" : ""}`);
      return `${it.id}|${it.status}|${it.name ?? ""}|${it.created}|${els.join(",")}`;
    })
    .join("\n");
}

function isLibraryItem(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { id?: unknown }).id === "string" &&
    Array.isArray((v as { elements?: unknown }).elements)
  );
}

/** Load the stored library once per session. Never rejects: failures resolve to `[]`. */
export function loadLibrary(): Promise<LibraryItems> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const store = await getStore();
        const raw = await store.get<unknown>(STORE_KEY);
        if (raw !== undefined && !Array.isArray(raw)) {
          throw new Error("stored library is not an array");
        }
        const items = ((raw as unknown[] | undefined) ?? []).filter(isLibraryItem);
        if (raw && items.length !== (raw as unknown[]).length) {
          log.warn(`library: skipped ${(raw as unknown[]).length - items.length} invalid item(s)`);
        }
        current = items as unknown as LibraryItems;
        currentHash = libraryHash(current);
      } catch (err) {
        saveDisabled = true;
        log.warn("library: couldn't load the stored library; changes won't be saved", err);
        current = [];
        currentHash = libraryHash(current);
      }
      loaded = true;
      return current;
    })();
  }
  return loadPromise;
}

/**
 * Record a library change reported by `source` (an editor's `onLibraryChange`). Persists it and
 * pushes it to every other registered editor. No-op before load, when unchanged, or when saving
 * is disabled. Resolves once the write finished (errors are logged, not thrown).
 */
export function saveLibrary(items: LibraryItems, source?: LibrarySink): Promise<void> {
  if (!loaded || saveDisabled) return writeChain;
  const hash = libraryHash(items);
  if (hash === currentHash) return writeChain;
  current = items;
  currentHash = hash;
  for (const sink of sinks) {
    if (sink === source) continue;
    sink.updateLibrary({ libraryItems: items, merge: false }).catch((err) => {
      log.warn("library: couldn't sync a change to another tab", err);
    });
  }
  writeChain = writeChain.then(async () => {
    try {
      const store = await getStore();
      await store.set(STORE_KEY, items);
      await store.save();
    } catch (err) {
      log.warn("library: couldn't save the library", err);
    }
  });
  return writeChain;
}

/** Receive library changes made in other tabs. Returns an unsubscribe function. */
export function registerLibrarySink(sink: LibrarySink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** For tests only — inject a fake store and reset all state. */
export function __resetLibraryStoreForTest(store: PersistedKV | null = null): void {
  storeSingleton = store;
  loadPromise = null;
  loaded = false;
  saveDisabled = false;
  current = [];
  currentHash = "";
  writeChain = Promise.resolve();
  sinks.clear();
}
