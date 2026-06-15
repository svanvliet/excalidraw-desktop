import { useCallback, useEffect, useRef, useState } from "react";
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
import { useTabsStore, ensureActiveTab } from "./stores/tabsStore";
import { useRecentFilesStore } from "./stores/recentFilesStore";
import { openFile, saveFile, isAppError } from "./ipc/commands";
import { detectFormat, serializeScene } from "./lib/fileFormat";

const EXCALIDRAW_FILTERS = [{ name: "Excalidraw", extensions: ["excalidraw"] }];

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

  const recentPaths = useRecentFilesStore((s) => s.paths);
  const loadRecent = useRecentFilesStore((s) => s.load);
  const addRecent = useRecentFilesStore((s) => s.add);
  const removeRecent = useRecentFilesStore((s) => s.remove);
  const clearRecent = useRecentFilesStore((s) => s.clear);

  useEffect(() => {
    ensureActiveTab();
    void loadRecent();
  }, [loadRecent]);

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

  const handleOpen = useCallback(async () => {
    setError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: EXCALIDRAW_FILTERS,
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
    markSavedAction(activeTab.id, chosen);
    void addRecent(chosen);
    return true;
  }, [activeTab, writeActiveTabTo, markSavedAction, addRecent]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      if (!activeTab) return false;
      if (activeTab.path) {
        await writeActiveTabTo(activeTab.id, activeTab.path);
        markSavedAction(activeTab.id, activeTab.path);
        void addRecent(activeTab.path);
        return true;
      }
      return await handleSaveAsInternal();
    } catch (e) {
      setError(formatError(e));
      return false;
    }
  }, [activeTab, writeActiveTabTo, markSavedAction, addRecent, handleSaveAsInternal]);

  const handleSaveAs = useCallback(async () => {
    setError(null);
    try {
      await handleSaveAsInternal();
    } catch (e) {
      setError(formatError(e));
    }
  }, [handleSaveAsInternal]);

  const handleNew = useCallback(() => newTab(), [newTab]);

  const requestCloseTab = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.dirty) {
        setPendingClose(id);
      } else {
        apisRef.current.delete(id);
        closeTabAction(id);
      }
    },
    [tabs, closeTabAction],
  );

  const pendingTab = pendingClose ? (tabs.find((t) => t.id === pendingClose) ?? null) : null;
  const pendingLabel = pendingTab ? (pendingTab.path ? basename(pendingTab.path) : "Untitled") : "";

  const handleConfirmSave = useCallback(async () => {
    if (!pendingClose) return;
    // Ensure the tab being closed is the one we save from.
    selectTab(pendingClose);
    const saved = await handleSave();
    if (saved) {
      apisRef.current.delete(pendingClose);
      closeTabAction(pendingClose);
      setPendingClose(null);
    }
  }, [pendingClose, selectTab, handleSave, closeTabAction]);

  const handleConfirmDiscard = useCallback(() => {
    if (!pendingClose) return;
    apisRef.current.delete(pendingClose);
    closeTabAction(pendingClose);
    setPendingClose(null);
  }, [pendingClose, closeTabAction]);

  const handleConfirmCancel = useCallback(() => setPendingClose(null), []);

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
              onSceneChange={() => markDirtyAction(tab.id)}
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
