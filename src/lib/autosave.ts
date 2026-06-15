/**
 * Per-tab debounced autosave.
 *
 * - Tabs with a real path are written back to that path after `delayMs`
 *   of scene-edit silence. This matches the modern macOS document model
 *   ("your file is always saved").
 * - Tabs without a path are written to a scratch file in the OS app-data
 *   dir, keyed by tab id, so session restore can offer to recover them.
 *
 * Snapshot collection (calling getSceneElements / getAppState / getFiles on
 * the Excalidraw API) is the caller's responsibility — it's passed in per
 * schedule call so each invocation captures the latest state at fire time.
 */

export interface AutosaveTarget {
  /** Real file path on disk; null means "untitled, use scratch". */
  path: string | null;
  /** Tab id used to key the scratch file (untitled tabs). */
  tabId: string;
  /** Returns the contents to write, or null to skip this write. */
  snapshot: () => string | null;
}

export interface AutosaveDeps {
  /** Persist contents to a real file path. */
  writeFile: (path: string, contents: string) => Promise<void>;
  /** Persist scratch contents for an untitled tab. */
  writeScratch: (tabId: string, contents: string) => Promise<void>;
  /** Called when an autosave write succeeds (so UI can clear "dirty"). */
  onSaved?: (target: AutosaveTarget) => void;
  /** Called when an autosave write throws. */
  onError?: (target: AutosaveTarget, err: unknown) => void;
}

export interface Autosaver {
  /** Schedule (or reschedule) a write for the given tab. */
  schedule: (target: AutosaveTarget) => void;
  /** Run the pending write immediately, if any (for shutdown/flush). */
  flush: (tabId: string) => Promise<void>;
  /** Cancel a pending write (e.g. after the tab is closed). */
  cancel: (tabId: string) => void;
  /** Cancel all pending writes. */
  cancelAll: () => void;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  run: () => Promise<void>;
}

export function createAutosaver(deps: AutosaveDeps, delayMs = 2000): Autosaver {
  const pending = new Map<string, Pending>();

  const cancel: Autosaver["cancel"] = (tabId) => {
    const entry = pending.get(tabId);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(tabId);
    }
  };

  const schedule: Autosaver["schedule"] = (target) => {
    cancel(target.tabId);
    const run = async () => {
      pending.delete(target.tabId);
      const contents = target.snapshot();
      if (contents === null) return;
      try {
        if (target.path) {
          await deps.writeFile(target.path, contents);
        } else {
          await deps.writeScratch(target.tabId, contents);
        }
        deps.onSaved?.(target);
      } catch (err) {
        deps.onError?.(target, err);
      }
    };
    const timer = setTimeout(() => {
      void run();
    }, delayMs);
    pending.set(target.tabId, { timer, run });
  };

  const flush: Autosaver["flush"] = async (tabId) => {
    const entry = pending.get(tabId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(tabId);
    await entry.run();
  };

  const cancelAll: Autosaver["cancelAll"] = () => {
    for (const id of Array.from(pending.keys())) cancel(id);
  };

  return { schedule, flush, cancel, cancelAll };
}
