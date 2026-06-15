/**
 * Persisted session state: which tabs were open and which was active.
 *
 * On launch we read the saved record and rebuild the tab list — file-backed
 * tabs by reopening the file, untitled tabs by loading their scratch entry.
 * Whenever the tabs store changes (add / remove / save) we re-persist.
 *
 * Files that no longer exist on disk are silently skipped; we don't want to
 * block startup on a stale entry from weeks ago.
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

import { useTabsStore, type Tab } from "./tabsStore";
import { openFile, listScratch, isAppError } from "../ipc/commands";
import { detectFormat } from "../lib/fileFormat";
import { restoreInitialData } from "../lib/excalidrawRestore";
import { log } from "../lib/logger";

const STORE_FILE = "session.json";
const STORE_KEY = "v1";

export interface PersistedTab {
  id: string;
  path: string | null;
}

export interface PersistedSession {
  tabs: PersistedTab[];
  activeTabId: string | null;
}

interface PersistedKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

let storeSingleton: PersistedKV | null = null;
async function getStore(): Promise<PersistedKV> {
  if (!storeSingleton) {
    storeSingleton = new LazyStore(STORE_FILE) as unknown as PersistedKV;
  }
  return storeSingleton;
}

/** For tests only — inject a fake store. */
export function __setSessionStoreForTest(store: PersistedKV | null): void {
  storeSingleton = store;
}

/** Pure projection of the in-memory tabs store into the persisted shape. */
export function snapshotSession(
  tabs: readonly Tab[],
  activeTabId: string | null,
): PersistedSession {
  return {
    tabs: tabs.map((t) => ({ id: t.id, path: t.path })),
    activeTabId,
  };
}

/** Persist the current tabs-store snapshot. Best-effort; errors are logged. */
export async function persistSession(): Promise<void> {
  try {
    const { tabs, activeTabId } = useTabsStore.getState();
    const snapshot = snapshotSession(tabs, activeTabId);
    const store = await getStore();
    await store.set(STORE_KEY, snapshot);
    await store.save();
  } catch (err) {
    log.warn("session persist failed", err);
  }
}

/** Read the persisted session, returning null if nothing is saved. */
export async function readPersistedSession(): Promise<PersistedSession | null> {
  try {
    const store = await getStore();
    const raw = await store.get<PersistedSession>(STORE_KEY);
    if (!raw || !Array.isArray(raw.tabs)) return null;
    return raw;
  } catch (e) {
    log.warn("session read failed, treating as empty", e);
    return null;
  }
}

export interface RestoreResult {
  restored: number;
  skipped: number;
}

/**
 * Load the persisted session and rebuild the tabs store.
 *
 * - File-backed tabs are reopened via the open_file command. Missing or
 *   unreadable files are dropped from the list.
 * - Untitled tabs are matched against scratch entries by tab id.
 * - If everything is skipped, returns without touching the tabs store so
 *   the caller's ensureActiveTab() can seed a blank tab as usual.
 */
export async function restoreSession(): Promise<RestoreResult> {
  log.info("restoreSession: start");
  let persisted: PersistedSession | null = null;
  try {
    persisted = await readPersistedSession();
  } catch (err) {
    log.error("restoreSession: read failed, starting fresh", err);
    return { restored: 0, skipped: 0 };
  }
  if (!persisted || persisted.tabs.length === 0) {
    log.info("restoreSession: nothing to restore");
    return { restored: 0, skipped: 0 };
  }
  log.info(
    `restoreSession: found ${persisted.tabs.length} persisted tabs, activeTabId=${persisted.activeTabId}`,
  );

  const scratchEntries = await listScratch().catch((err) => {
    log.warn("restoreSession: listScratch failed", err);
    return [];
  });
  const scratchByKey = new Map(scratchEntries.map((e) => [e.key, e.contents]));

  const restored: Tab[] = [];
  let skipped = 0;

  for (const entry of persisted.tabs) {
    try {
      if (entry.path) {
        try {
          const opened = await openFile(entry.path);
          const detected = detectFormat(opened.contents);
          if (detected.kind !== "excalidraw-json" || !detected.parsed) {
            log.warn(
              `restoreSession: skipping tab ${entry.id} — file content not JSON (${detected.kind})`,
            );
            skipped += 1;
            continue;
          }
          restored.push({
            id: entry.id,
            path: opened.path,
            dirty: false,
            initialData: toInitial(detected.parsed),
          });
        } catch (err) {
          if (isAppError(err)) {
            log.warn(`restoreSession: skipping missing recent tab ${entry.path}`, err);
          } else {
            log.error(`restoreSession: open failed for ${entry.path}`, err);
          }
          skipped += 1;
        }
      } else {
        const scratch = scratchByKey.get(entry.id);
        if (!scratch) {
          log.warn(`restoreSession: no scratch found for untitled tab ${entry.id}`);
          skipped += 1;
          continue;
        }
        const detected = detectFormat(scratch);
        if (detected.kind !== "excalidraw-json" || !detected.parsed) {
          log.warn(`restoreSession: scratch for tab ${entry.id} not JSON (${detected.kind})`);
          skipped += 1;
          continue;
        }
        restored.push({
          id: entry.id,
          path: null,
          dirty: true,
          initialData: toInitial(detected.parsed),
        });
      }
    } catch (err) {
      // Belt and braces: a malformed entry must never crash the whole boot.
      log.error(`restoreSession: unexpected failure on tab ${entry.id}`, err);
      skipped += 1;
    }
  }

  if (restored.length === 0) {
    log.info(`restoreSession: nothing restored (skipped=${skipped})`);
    return { restored: 0, skipped };
  }

  const wantedActive =
    persisted.activeTabId && restored.some((t) => t.id === persisted.activeTabId)
      ? persisted.activeTabId
      : restored[0].id;

  try {
    useTabsStore.getState().replaceAll(restored, wantedActive);
  } catch (err) {
    log.error("restoreSession: replaceAll threw — clearing tabs", err);
    return { restored: 0, skipped: skipped + restored.length };
  }
  log.info(`restoreSession: restored=${restored.length} skipped=${skipped} active=${wantedActive}`);
  return { restored: restored.length, skipped };
}

function toInitial(parsed: {
  elements?: unknown;
  appState?: unknown;
  files?: unknown;
}): ExcalidrawInitialDataState {
  // Funnel everything through Excalidraw's restore() so `collaborators`
  // and other Map-typed fields are reconstructed correctly. Skipping
  // this step crashes <Excalidraw> with
  // `props.appState.collaborators.forEach is not a function`.
  return restoreInitialData(parsed);
}
