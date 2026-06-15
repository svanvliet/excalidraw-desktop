import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { ExcalidrawCanvas } from "./components/ExcalidrawCanvas";
import { Toolbar } from "./components/Toolbar";
import { TabBar } from "./components/TabBar";
import { ConfirmCloseDialog } from "./components/ConfirmCloseDialog";
import { RecentMenu } from "./components/RecentMenu";
import { SettingsDialog } from "./components/SettingsDialog";
import { useTabsStore, ensureActiveTab } from "./stores/tabsStore";
import { useRecentFilesStore } from "./stores/recentFilesStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useThemeStore } from "./stores/themeStore";
import { persistSession, restoreSession } from "./stores/sessionStore";
import {
  openFile,
  saveFile,
  readFileBytes,
  writeFileBytes,
  writeScratch,
  deleteScratch,
  isAppError,
} from "./ipc/commands";
import {
  detectFormat,
  serializeScene,
  looksLikePng,
  base64ToBytes,
  bytesToBase64,
  formatFromExtension,
} from "./lib/fileFormat";
import { exportSceneAsPng, loadScenePng } from "./lib/pngScene";
import { createAutosaver } from "./lib/autosave";
import { onFileOpenRequest, onWindowFileDrop } from "./ipc/openEvents";
import { onMenuEvent, dispatchShortcut, type MenuItemId } from "./ipc/menuEvents";
import { log } from "./lib/logger";

const OPEN_FILTERS = [
  { name: "Excalidraw", extensions: ["excalidraw", "png"] },
  { name: "Excalidraw JSON", extensions: ["excalidraw"] },
  { name: "PNG (with embedded scene)", extensions: ["png"] },
];
const EXCALIDRAW_FILTERS = [{ name: "Excalidraw", extensions: ["excalidraw"] }];
const PNG_FILTERS = [{ name: "PNG", extensions: ["png"] }];

export function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const selectTab = useTabsStore((s) => s.selectTab);
  const newTab = useTabsStore((s) => s.newTab);
  const openTabAction = useTabsStore((s) => s.openTab);
  const markDirtyAction = useTabsStore((s) => s.markDirty);
  const markSavedAction = useTabsStore((s) => s.markSaved);
  const closeTabAction = useTabsStore((s) => s.closeTab);

  const apisRef = useRef<Map<string, ExcalidrawImperativeAPI>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loadSettings = useSettingsStore((s) => s.load);
  const loadTheme = useThemeStore((s) => s.load);
  const resolvedTheme = useThemeStore((s) => s.resolved);

  const recentPaths = useRecentFilesStore((s) => s.paths);
  const loadRecent = useRecentFilesStore((s) => s.load);
  const addRecent = useRecentFilesStore((s) => s.add);
  const removeRecent = useRecentFilesStore((s) => s.remove);
  const clearRecent = useRecentFilesStore((s) => s.clear);

  const collabEnabled = useSettingsStore((s) => s.collab);
  const libraryEnabled = useSettingsStore((s) => s.library);
  const aiEnabled = useSettingsStore((s) => s.ai);
  // The official Excalidraw web app uses its own URL as the library return
  // target. For our desktop wrapper there's no callback URL — we just need
  // a non-empty value to let Excalidraw render the library UI. Keep it
  // pointing at the public docs as a benign placeholder.
  const libraryReturnUrl = libraryEnabled ? "https://libraries.excalidraw.com" : undefined;

  // Build the autosaver once; deps are stable references to IPC + store
  // helpers, and the per-tab snapshot fn is supplied at schedule time.
  const autosaver = useMemo(
    () =>
      createAutosaver(
        {
          writeFile: (path, contents) => saveFile(path, contents),
          writeScratch: (key, contents) => writeScratch(key, contents),
          onSaved: (target) => {
            // Only file-backed autosaves clear the dirty flag. Scratch-saves
            // for untitled tabs keep dirty=true so the tab still nags the
            // user to do a real Save.
            if (target.path) {
              useTabsStore.getState().markSaved(target.tabId, target.path);
            }
          },
          onError: (_target, err) => {
            // Surface but don't block the UI — autosave is best-effort.
            log.warn("autosave failed", err);
          },
        },
        2000,
      ),
    [],
  );

  const captureSnapshot = useCallback((tabId: string): string | null => {
    const api = apisRef.current.get(tabId);
    if (!api) return null;
    return serializeScene(
      api.getSceneElements(),
      api.getAppState() as unknown as Record<string, unknown>,
      api.getFiles() as unknown as Record<string, unknown>,
    );
  }, []);

  const scheduleAutosave = useCallback(
    (tabId: string) => {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      autosaver.schedule({
        tabId,
        path: tab.path,
        snapshot: () => captureSnapshot(tabId),
      });
    },
    [autosaver, captureSnapshot],
  );

  // Ref to the latest openPath so the file-open subscription doesn't have
  // to re-subscribe whenever the callback identity changes.
  const openPathRef = useRef<(path: string) => Promise<void> | void>(() => {});
  // Same pattern for menu events: subscribe once at mount, always call
  // the freshest handler closure via this ref.
  const menuActionRef = useRef<(id: MenuItemId) => void>(() => {});

  useEffect(() => {
    log.info("App: mount effect starting");
    let cancelled = false;
    let unlistenFileOpen: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    let unlistenMenu: (() => void) | null = null;
    (async () => {
      // Try to restore the previous session first; only seed a blank tab
      // if there was nothing to restore (or every entry was missing).
      let restored = 0;
      try {
        const result = await restoreSession();
        restored = result.restored;
      } catch (err) {
        log.error("App: restoreSession threw, falling back to blank tab", err);
      }
      if (cancelled) return;
      if (restored === 0) {
        log.info("App: seeding blank tab via ensureActiveTab()");
        ensureActiveTab();
      }
      void loadRecent();
      void loadSettings();
      void loadTheme();
      log.info("App: stores loaded (recent, settings, theme)");
      // Subscribe to OS file-open events (double-click, drag-onto-icon,
      // single-instance reroute) and route them through the latest openPath.
      // Each subscription is wrapped so a missing Tauri runtime (web preview
      // for Playwright smoke) doesn't crash the mount effect.
      try {
        unlistenFileOpen = await onFileOpenRequest((path) => {
          log.info(`App: file-open event path=${path}`);
          void openPathRef.current(path);
        });
      } catch (e) {
        log.warn("App: file-open subscription unavailable", e);
      }
      try {
        unlistenDrop = await onWindowFileDrop((path) => {
          log.info(`App: file-drop event path=${path}`);
          void openPathRef.current(path);
        });
      } catch (e) {
        log.warn("App: drag-drop subscription unavailable", e);
      }
      try {
        unlistenMenu = await onMenuEvent((id) => {
          log.info(`App: menu event id=${id}`);
          menuActionRef.current(id);
        });
      } catch (e) {
        log.warn("App: menu subscription unavailable", e);
      }
      if (cancelled) {
        unlistenFileOpen?.();
        unlistenDrop?.();
        unlistenMenu?.();
        unlistenFileOpen = null;
        unlistenDrop = null;
        unlistenMenu = null;
      } else {
        log.info("App: mount effect ready");
      }
    })();
    // Persist session on every tabs-store change.
    const unsubscribe = useTabsStore.subscribe(() => {
      void persistSession();
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unlistenFileOpen?.();
      unlistenDrop?.();
      unlistenMenu?.();
      autosaver.cancelAll();
    };
  }, [loadRecent, loadSettings, loadTheme, autosaver]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activePath = activeTab?.path ?? null;
  const activeDirty = activeTab?.dirty ?? false;

  const handleApi = useCallback((id: string, api: ExcalidrawImperativeAPI) => {
    apisRef.current.set(id, api);
  }, []);

  const openPath = useCallback(
    async (path: string) => {
      setError(null);
      try {
        if (formatFromExtension(path) === "png") {
          const opened = await readFileBytes(path);
          const bytes = base64ToBytes(opened.base64);
          if (!looksLikePng(bytes)) {
            setError("File extension is .png but the contents are not a valid PNG.");
            return;
          }
          const initial = await loadScenePng(bytes);
          if (!initial) {
            setError("No Excalidraw scene found in this PNG.");
            return;
          }
          openTabAction(opened.path, initial);
          void addRecent(opened.path);
          return;
        }

        const opened = await openFile(path);
        const detected = detectFormat(opened.contents);
        if (detected.kind !== "excalidraw-json" || !detected.parsed) {
          setError(`Not a valid Excalidraw file: ${detected.reason ?? "unknown format"}`);
          return;
        }
        const initial: ExcalidrawInitialDataState = {
          elements: detected.parsed.elements as ExcalidrawInitialDataState["elements"],
          appState: detected.parsed.appState as ExcalidrawInitialDataState["appState"],
          files: detected.parsed.files as ExcalidrawInitialDataState["files"],
        };
        openTabAction(opened.path, initial);
        void addRecent(opened.path);
      } catch (e) {
        // If the file no longer exists, drop it from the recent list so the
        // menu doesn't keep showing a broken entry.
        if (isAppError(e) && e.kind === "io") {
          void removeRecent(path);
        }
        setError(formatError(e));
      }
    },
    [openTabAction, addRecent, removeRecent],
  );

  // Keep the ref pointed at the latest openPath so the file-open subscriber
  // (registered once at mount) always calls the freshest closure.
  useEffect(() => {
    openPathRef.current = openPath;
  }, [openPath]);

  const handleOpen = useCallback(async () => {
    setError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: OPEN_FILTERS,
      });
      if (typeof selected !== "string") return;
      await openPath(selected);
    } catch (e) {
      setError(formatError(e));
    }
  }, [openPath]);

  const writeActiveTabTo = useCallback(async (id: string, path: string) => {
    const api = apisRef.current.get(id);
    if (!api) throw new Error("editor is not ready yet");
    const contents = serializeScene(
      api.getSceneElements(),
      api.getAppState() as unknown as Record<string, unknown>,
      api.getFiles() as unknown as Record<string, unknown>,
    );
    await saveFile(path, contents);
  }, []);

  const handleSaveAsInternal = useCallback(async (): Promise<boolean> => {
    if (!activeTab) return false;
    const chosen = await saveDialog({
      defaultPath: activeTab.path ?? "untitled.excalidraw",
      filters: EXCALIDRAW_FILTERS,
    });
    if (typeof chosen !== "string") return false;
    await writeActiveTabTo(activeTab.id, chosen);
    // A successful Save As means any scratch entry for this (previously
    // untitled) tab is now obsolete.
    autosaver.cancel(activeTab.id);
    void deleteScratch(activeTab.id).catch(() => {});
    markSavedAction(activeTab.id, chosen);
    void addRecent(chosen);
    return true;
  }, [activeTab, writeActiveTabTo, markSavedAction, addRecent, autosaver]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      if (!activeTab) return false;
      if (activeTab.path) {
        await writeActiveTabTo(activeTab.id, activeTab.path);
        autosaver.cancel(activeTab.id);
        markSavedAction(activeTab.id, activeTab.path);
        void addRecent(activeTab.path);
        return true;
      }
      return await handleSaveAsInternal();
    } catch (e) {
      setError(formatError(e));
      return false;
    }
  }, [activeTab, writeActiveTabTo, markSavedAction, addRecent, handleSaveAsInternal, autosaver]);

  const handleSaveAs = useCallback(async () => {
    setError(null);
    try {
      await handleSaveAsInternal();
    } catch (e) {
      setError(formatError(e));
    }
  }, [handleSaveAsInternal]);

  const handleExportPng = useCallback(async () => {
    setError(null);
    try {
      if (!activeTab) return;
      const api = apisRef.current.get(activeTab.id);
      if (!api) return;
      const defaultName = activeTab.path
        ? activeTab.path.replace(/\.(excalidraw|png)$/i, "") + ".png"
        : "untitled.png";
      const chosen = await saveDialog({
        defaultPath: defaultName,
        filters: PNG_FILTERS,
      });
      if (typeof chosen !== "string") return;
      const blob = await exportSceneAsPng(api);
      const buf = new Uint8Array(await blob.arrayBuffer());
      await writeFileBytes(chosen, bytesToBase64(buf));
      // Track the exported PNG in recent files so the user can re-open it.
      void addRecent(chosen);
    } catch (e) {
      setError(formatError(e));
    }
  }, [activeTab, addRecent]);

  const handleNew = useCallback(() => newTab(), [newTab]);

  const requestCloseTab = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.dirty) {
        setPendingClose(id);
      } else {
        autosaver.cancel(id);
        if (!tab.path) void deleteScratch(id).catch(() => {});
        apisRef.current.delete(id);
        closeTabAction(id);
      }
    },
    [tabs, closeTabAction, autosaver],
  );

  const pendingTab = pendingClose ? (tabs.find((t) => t.id === pendingClose) ?? null) : null;
  const pendingLabel = pendingTab ? (pendingTab.path ? basename(pendingTab.path) : "Untitled") : "";

  const handleConfirmSave = useCallback(async () => {
    if (!pendingClose) return;
    // Ensure the tab being closed is the one we save from.
    selectTab(pendingClose);
    const saved = await handleSave();
    if (saved) {
      autosaver.cancel(pendingClose);
      apisRef.current.delete(pendingClose);
      closeTabAction(pendingClose);
      setPendingClose(null);
    }
  }, [pendingClose, selectTab, handleSave, closeTabAction, autosaver]);

  const handleConfirmDiscard = useCallback(() => {
    if (!pendingClose) return;
    const tab = useTabsStore.getState().tabs.find((t) => t.id === pendingClose);
    autosaver.cancel(pendingClose);
    if (tab && !tab.path) void deleteScratch(pendingClose).catch(() => {});
    apisRef.current.delete(pendingClose);
    closeTabAction(pendingClose);
    setPendingClose(null);
  }, [pendingClose, closeTabAction, autosaver]);

  const handleConfirmCancel = useCallback(() => setPendingClose(null), []);

  const handleMenuAction = useCallback(
    (id: MenuItemId) => {
      switch (id) {
        case "excalidraw:file:new":
          handleNew();
          return;
        case "excalidraw:file:open":
          void handleOpen();
          return;
        case "excalidraw:file:save":
          void handleSave();
          return;
        case "excalidraw:file:saveAs":
          void handleSaveAs();
          return;
        case "excalidraw:file:exportPng":
          void handleExportPng();
          return;
        case "excalidraw:file:closeTab":
          if (activeTabId) requestCloseTab(activeTabId);
          return;
        case "excalidraw:file:settings":
          setSettingsOpen(true);
          return;
        case "excalidraw:edit:undo":
          // Excalidraw owns its history stack — replay the keyboard
          // shortcut so its internal handler runs.
          dispatchShortcut({ key: "z" });
          return;
        case "excalidraw:edit:redo":
          dispatchShortcut({ key: "z", shift: true });
          return;
        case "excalidraw:view:zoomIn":
          dispatchShortcut({ key: "=" });
          return;
        case "excalidraw:view:zoomOut":
          dispatchShortcut({ key: "-" });
          return;
        case "excalidraw:view:zoomReset":
          dispatchShortcut({ key: "0" });
          return;
        case "excalidraw:help:about":
          setError(
            "Excalidraw Desktop — a local-first wrapper around the official Excalidraw editor.",
          );
          return;
        case "excalidraw:help:docs":
          // The plugin-opener is registered in lib.rs; loading lazily keeps
          // it out of the test mock surface.
          void import("@tauri-apps/plugin-opener")
            .then(({ openUrl }) => openUrl("https://docs.excalidraw.com/"))
            .catch(() => {});
          return;
      }
    },
    [
      activeTabId,
      handleNew,
      handleOpen,
      handleSave,
      handleSaveAs,
      handleExportPng,
      requestCloseTab,
    ],
  );

  useEffect(() => {
    menuActionRef.current = handleMenuAction;
  }, [handleMenuAction]);

  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(id);
  }, [error]);

  return (
    <main className="app-shell">
      <Toolbar
        documentPath={activePath}
        dirty={activeDirty}
        onOpen={handleOpen}
        onSave={() => void handleSave()}
        onSaveAs={handleSaveAs}
        onExportPng={handleExportPng}
        onOpenSettings={() => setSettingsOpen(true)}
      >
        <RecentMenu
          paths={recentPaths}
          onOpen={(path) => void openPath(path)}
          onClear={() => void clearRecent()}
        />
      </Toolbar>
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={selectTab}
        onClose={requestCloseTab}
        onNew={handleNew}
      />
      {error ? (
        <div className="app-shell__error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="app-shell__canvas">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="canvas-slot"
            data-active={tab.id === activeTabId || undefined}
            aria-hidden={tab.id === activeTabId ? undefined : true}
          >
            <ExcalidrawCanvas
              initialData={tab.initialData}
              onApi={(api) => handleApi(tab.id, api)}
              onSceneChange={() => {
                markDirtyAction(tab.id);
                scheduleAutosave(tab.id);
              }}
              aiEnabled={aiEnabled}
              isCollaborating={collabEnabled}
              libraryReturnUrl={libraryReturnUrl}
              theme={resolvedTheme}
            />
          </div>
        ))}
      </div>
      <ConfirmCloseDialog
        open={pendingClose !== null}
        tabLabel={pendingLabel}
        onSave={handleConfirmSave}
        onDiscard={handleConfirmDiscard}
        onCancel={handleConfirmCancel}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </main>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function formatError(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}
