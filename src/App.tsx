import { referencedFiles } from "./extensions/stack";
import { persistedElements } from "./extensions/components/persist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { ExcalidrawCanvas } from "./components/ExcalidrawCanvas";
import { Toolbar } from "./components/Toolbar";
import { AgentPanel } from "./components/agent/AgentPanel";
import { installAgentStore, useAgentStore } from "./stores/agentStore";
import { installAgentRuntime } from "./agent/runtime";
import { TabBar } from "./components/TabBar";
import { ConfirmCloseDialog } from "./components/ConfirmCloseDialog";
import { RecentMenu } from "./components/RecentMenu";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShareDialog } from "./components/ShareDialog";
import { EditRequestBar, ViewerBar } from "./components/RoleBar";
import { JoinDialog } from "./components/JoinDialog";
import { UpdateController } from "./components/UpdateController";
import { useCollabStore } from "./stores/collabStore";
import {
  collabSetRole,
  collabStop,
  fileOpenReady,
  osUserName,
  setRecentMenu,
} from "./ipc/commands";
import type { RoomLink } from "./collab/protocol";
import { useCollabSession } from "./collab/useCollabSession";
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
  displayName,
  recentMenuLabels,
} from "./lib/fileFormat";
import { exportSceneAsPng, loadScenePng } from "./lib/pngScene";
import { createAutosaver } from "./lib/autosave";
import { restoreInitialData } from "./lib/excalidrawRestore";
import { onFileOpenRequest, onWindowFileDrop } from "./ipc/openEvents";
import { onMenuEvent, dispatchShortcut, type MenuItemId } from "./ipc/menuEvents";
import { runLayoutCommand } from "./layout/commands";
import { createComponentFromSelection } from "./extensions/components/host";
import { log } from "./lib/logger";
import { remoteApi } from "./extensions/components/host";
import {
  registerSceneTab,
  listSceneTabs,
  setActiveSceneTab,
  unregisterSceneTab,
} from "./agent/sceneBridge";
import { resetTurns } from "./agent/scene/turns";

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
  const [shareOpen, setShareOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  const loadSettings = useSettingsStore((s) => s.load);
  const loadTheme = useThemeStore((s) => s.load);
  const resolvedTheme = useThemeStore((s) => s.resolved);

  const recentPaths = useRecentFilesStore((s) => s.paths);
  const loadRecent = useRecentFilesStore((s) => s.load);
  const addRecent = useRecentFilesStore((s) => s.add);
  const removeRecent = useRecentFilesStore((s) => s.remove);
  const clearRecent = useRecentFilesStore((s) => s.clear);

  const collabSession = useCollabStore((s) => s.session);
  const initCollab = useCollabStore((s) => s.init);
  const joinCollab = useCollabStore((s) => s.joinSession);
  const endCollabForTab = useCollabStore((s) => s.endSessionForTab);
  const libraryEnabled = useSettingsStore((s) => s.library);
  const aiEnabled = useSettingsStore((s) => s.ai);
  const agentPanelOpen = useAgentStore((s) => s.panelOpen);
  const toggleAgentPanel = useAgentStore((s) => s.togglePanel);
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
              // Drop any backup taken while autosave was off.
              void deleteScratch(target.tabId).catch(() => {});
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
    return serializeSceneOf(api);
  }, []);

  const scheduleAutosave = useCallback(
    (tabId: string) => {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      // With autosave off, file-backed tabs are backed up to scratch (like
      // untitled ones) and the file itself only changes on an explicit Save.
      const writeToFile = useSettingsStore.getState().autosave;
      autosaver.schedule({
        tabId,
        path: writeToFile ? tab.path : null,
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
      void initCollab();
      log.info("App: stores loaded (recent, settings, theme, collab)");
      // Subscribe to OS file-open events (double-click, drag-onto-icon,
      // single-instance reroute) and route them through the latest openPath.
      // Each subscription is wrapped so a missing Tauri runtime (web preview
      // for Playwright smoke) doesn't crash the mount effect.
      try {
        unlistenFileOpen = await onFileOpenRequest((path) => {
          log.info(`App: file-open event path=${path}`);
          void openPathRef.current(path);
        });
        // Opens that arrived before we subscribed (e.g. the Finder
        // double-click that launched the app) were queued in Rust.
        for (const path of await fileOpenReady()) {
          log.info(`App: queued file-open path=${path}`);
          await openPathRef.current(path);
        }
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
    // Best-effort: tear down a hosted collab session when the window goes
    // away. The Rust side also kills the relay/tunnel on exit.
    const handleUnload = () => {
      if (useCollabStore.getState().session?.role === "host") void collabStop().catch(() => {});
    };
    window.addEventListener("beforeunload", handleUnload);
    // Persist session on every tabs-store change.
    const unsubscribe = useTabsStore.subscribe(() => {
      void persistSession();
    });
    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", handleUnload);
      unsubscribe();
      unlistenFileOpen?.();
      unlistenDrop?.();
      unlistenMenu?.();
      autosaver.cancelAll();
    };
  }, [loadRecent, loadSettings, loadTheme, initCollab, autosaver]);

  // Mirror recent files into the native File → Open Recent submenu.
  useEffect(() => {
    const labels = recentMenuLabels(recentPaths);
    setRecentMenu(recentPaths.map((path, i) => ({ path, label: labels[i] }))).catch((e) =>
      log.warn("App: set_recent_menu failed", e),
    );
  }, [recentPaths]);

  // Default collab display name: the OS user's name, unless set in Settings.
  const [osName, setOsName] = useState("");
  useEffect(() => {
    osUserName()
      .then(setOsName)
      .catch(() => {});
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activePath = activeTab?.path ?? null;
  const activeDirty = activeTab?.dirty ?? false;

  // Bumped when a tab's Excalidraw API (re)mounts so the collab binding can
  // pick it up — apisRef alone doesn't trigger a render.
  const [apiTick, setApiTick] = useState(0);
  // Agent scene bridge (docs/ai-integration.md): refs keep the registered
  // callbacks current without re-registering on every render.
  const agentViewerTabRef = useRef<string | null>(null);
  const agentMarkDirtyRef = useRef<(id: string) => void>(() => {});
  const handleApi = useCallback((id: string, api: ExcalidrawImperativeAPI) => {
    if (apisRef.current.get(id) === api) return;
    apisRef.current.set(id, api);
    registerSceneTab(id, {
      api,
      title: () => {
        const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
        return tab?.path ? displayName(tab.path) : "Untitled";
      },
      isViewer: () => agentViewerTabRef.current === id,
      markDirty: () => agentMarkDirtyRef.current(id),
    });
    setApiTick((t) => t + 1);
  }, []);
  useEffect(() => {
    agentMarkDirtyRef.current = (id) => {
      markDirtyAction(id);
      scheduleAutosave(id);
    };
  }, [markDirtyAction, scheduleAutosave]);
  useEffect(() => setActiveSceneTab(activeTabId), [activeTabId]);
  useEffect(() => {
    const open = new Set(tabs.map((t) => t.id));
    for (const { tabId } of listSceneTabs()) {
      if (!open.has(tabId)) {
        unregisterSceneTab(tabId);
        resetTurns(tabId);
      }
    }
  }, [tabs]);

  // --- Live collaboration binding (docs/collab-protocol.md) -----------------
  // The host's own webview always talks to the loopback relay; guests use the
  // public base from the pasted link.
  const relayRunning = useCollabStore((s) => s.status.running);
  const relayRoomId = useCollabStore((s) => s.status.roomId);
  const relayLocalBase = useCollabStore((s) => s.status.localBase);
  const relayHostToken = useCollabStore((s) => s.status.hostToken);
  const leaveCollab = useCollabStore((s) => s.leaveSession);
  const collabDisplayName = useSettingsStore((s) => s.collabDisplayName);
  const collabTabId = collabSession?.tabId ?? null;
  const collabTab = collabTabId ? tabs.find((t) => t.id === collabTabId) : undefined;
  const collabTabLabel = collabTab?.path ? displayName(collabTab.path) : "Untitled";
  const collabLink = useMemo<RoomLink | null>(() => {
    if (!collabSession) return null;
    if (collabSession.role === "guest") {
      return collabSession.publicBase
        ? {
            publicBase: collabSession.publicBase,
            roomId: collabSession.roomId,
            key: collabSession.key,
          }
        : null;
    }
    if (!relayRunning || !relayLocalBase || relayRoomId !== collabSession.roomId) return null;
    return { publicBase: relayLocalBase, roomId: collabSession.roomId, key: collabSession.key };
  }, [collabSession, relayRunning, relayLocalBase, relayRoomId]);
  const collabApi = useMemo(
    // Remote applies are tagged so the components engine doesn't re-derive them (the sender
    // already synced its instances).
    () => remoteApi(collabTabId ? (apisRef.current.get(collabTabId) ?? null) : null),
    // apiTick re-reads the ref once the bound tab's canvas mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collabTabId, apiTick],
  );
  const collabUsername =
    collabDisplayName.trim() || osName || (collabSession?.role === "host" ? "Host" : "Guest");
  const collab = useCollabSession({
    api: collabApi,
    link: collabLink,
    username: collabUsername,
    isHost: collabSession?.role === "host",
    hostToken: collabSession?.role === "host" ? relayHostToken : null,
    onRemoteChange: () => {
      if (!collabTabId) return;
      markDirtyAction(collabTabId);
      scheduleAutosave(collabTabId);
    },
  });
  useEffect(() => {
    agentViewerTabRef.current =
      collabSession?.role === "guest" && collab.role === "viewer" ? collabTabId : null;
  }, [collabSession?.role, collab.role, collabTabId]);
  // A guest never keeps the shared drawing: when its session goes away (Leave,
  // host ended, removed), wipe that tab. The engine is already stopped by then,
  // so the reset can't reach the room.
  const guestTabRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = guestTabRef.current;
    guestTabRef.current = collabSession?.role === "guest" ? collabSession.tabId : null;
    if (prev && prev !== guestTabRef.current) apisRef.current.get(prev)?.resetScene();
  }, [collabSession]);

  useEffect(() => {
    if (collab.status === "ended") {
      leaveCollab();
      setError("The host ended the live session.");
    } else if (collab.status === "removed") {
      leaveCollab();
      setError("The host removed you from the live session.");
    } else if (collab.status === "failed" && collab.error) {
      log.warn("collab: session failed", collab.error);
      setError(`Live session error: ${collab.error.message}`);
    }
  }, [collab.status, collab.error, leaveCollab]);

  const allowEdit = useCallback((clientId: string) => {
    collabSetRole(clientId, "editor").catch((e) => {
      log.warn("collab: set role failed", e);
      setError(`Couldn't change that person's role: ${String(e)}`);
    });
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
          openTabAction(opened.path, restoreInitialData(initial));
          void addRecent(opened.path);
          return;
        }

        const opened = await openFile(path);
        const detected = detectFormat(opened.contents);
        if (detected.kind !== "excalidraw-json" || !detected.parsed) {
          setError(`Not a valid Excalidraw file: ${detected.reason ?? "unknown format"}`);
          return;
        }
        // Funnel through Excalidraw's restore() — keeps `collaborators`
        // a Map and prevents the InteractiveCanvas crash that would
        // otherwise unmount the editor.
        const initial = restoreInitialData(detected.parsed);
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
    await saveFile(path, serializeSceneOf(api));
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
        void deleteScratch(activeTab.id).catch(() => {});
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

  // Closing a tab ends any live session bound to it.
  const closeTab = useCallback(
    (id: string) => {
      void endCollabForTab(id);
      closeTabAction(id);
    },
    [endCollabForTab, closeTabAction],
  );

  const handleJoin = useCallback(
    (link: RoomLink) => {
      const tabId = newTab();
      if (!joinCollab(link, tabId)) {
        setError("Couldn't join: live collaboration is off or a session is already active.");
      }
    },
    [newTab, joinCollab],
  );

  const requestCloseTab = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.dirty) {
        setPendingClose(id);
      } else {
        autosaver.cancel(id);
        void deleteScratch(id).catch(() => {});
        apisRef.current.delete(id);
        closeTab(id);
      }
    },
    [tabs, closeTab, autosaver],
  );

  const pendingTab = pendingClose ? (tabs.find((t) => t.id === pendingClose) ?? null) : null;
  const pendingLabel = pendingTab
    ? pendingTab.path
      ? displayName(pendingTab.path)
      : "Untitled"
    : "";

  const handleConfirmSave = useCallback(async () => {
    if (!pendingClose) return;
    // Ensure the tab being closed is the one we save from.
    selectTab(pendingClose);
    const saved = await handleSave();
    if (saved) {
      autosaver.cancel(pendingClose);
      apisRef.current.delete(pendingClose);
      closeTab(pendingClose);
      setPendingClose(null);
    }
  }, [pendingClose, selectTab, handleSave, closeTab, autosaver]);

  const handleConfirmDiscard = useCallback(() => {
    if (!pendingClose) return;
    const tab = useTabsStore.getState().tabs.find((t) => t.id === pendingClose);
    autosaver.cancel(pendingClose);
    if (tab) void deleteScratch(pendingClose).catch(() => {});
    apisRef.current.delete(pendingClose);
    closeTab(pendingClose);
    setPendingClose(null);
  }, [pendingClose, closeTab, autosaver]);

  const handleConfirmCancel = useCallback(() => setPendingClose(null), []);

  // Write pending autosaves before restarting into an update.
  const flushBeforeUpdate = useCallback(async () => {
    await Promise.all(useTabsStore.getState().tabs.map((t) => autosaver.flush(t.id)));
    await persistSession();
  }, [autosaver]);

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
        case "excalidraw:file:clearRecent":
          void clearRecent();
          return;
        case "excalidraw:edit:undo":
          // Excalidraw owns its history stack — replay the keyboard
          // shortcut so its internal handler runs.
          dispatchShortcut({ key: "z" });
          return;
        case "excalidraw:edit:redo":
          dispatchShortcut({ key: "z", shift: true });
          return;
        case "excalidraw:edit:createComponent": {
          const api = activeTabId ? apisRef.current.get(activeTabId) : undefined;
          if (api) createComponentFromSelection(api);
          return;
        }
        case "excalidraw:view:zoomIn":
          dispatchShortcut({ key: "=" });
          return;
        case "excalidraw:view:zoomOut":
          dispatchShortcut({ key: "-" });
          return;
        case "excalidraw:view:zoomReset":
          dispatchShortcut({ key: "0" });
          return;
        case "excalidraw:view:aiPanel":
          // With AI off there's no panel to show; send the user to the opt-in toggle.
          if (useSettingsStore.getState().ai) useAgentStore.getState().togglePanel();
          else setSettingsOpen(true);
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
        default: {
          // Layout ▸ … (src/layout/commands.json)
          const api = activeTabId ? apisRef.current.get(activeTabId) : undefined;
          if (api) runLayoutCommand(id, api);
          return;
        }
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
      clearRecent,
    ],
  );

  useEffect(() => {
    menuActionRef.current = handleMenuAction;
  }, [handleMenuAction]);

  useEffect(() => installAgentStore(), []);
  useEffect(() => installAgentRuntime(), []);

  // ⌘/Ctrl+Shift+A toggles the AI panel (only while AI is on). Capture phase
  // so Excalidraw's own key handling doesn't see it.
  useEffect(() => {
    if (!aiEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyA") {
        e.preventDefault();
        e.stopPropagation();
        toggleAgentPanel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [aiEnabled, toggleAgentPanel]);

  const activeTabIsViewer =
    !!activeTabId &&
    collabTabId === activeTabId &&
    collabSession?.role === "guest" &&
    collab.role === "viewer";

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
        onShare={() => setShareOpen(true)}
        onJoin={() => setJoinOpen(true)}
        livePeerCount={
          collabSession && collabTabId === activeTabId ? collab.peers.length + 1 : null
        }
        liveElsewhere={!!collabSession && collabTabId !== activeTabId}
        onToggleAgent={aiEnabled ? toggleAgentPanel : undefined}
        agentOpen={aiEnabled && agentPanelOpen}
        onLayoutCommand={(id) => {
          const api = activeTabId ? apisRef.current.get(activeTabId) : undefined;
          if (api) runLayoutCommand(id, api);
        }}
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
        liveTabId={collabTabId}
      />
      {error ? (
        <div className="app-shell__error" role="alert">
          {error}
        </div>
      ) : null}
      {collabSession?.role === "host" ? (
        <EditRequestBar peers={collab.peers} onAllow={allowEdit} onDeny={collab.denyEdit} />
      ) : collabSession?.role === "guest" &&
        collabTabId === activeTabId &&
        collab.status === "connected" &&
        collab.role === "viewer" ? (
        <ViewerBar state={collab.editRequest} onRequest={collab.requestEdit} />
      ) : null}
      <div className="app-shell__workspace">
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
                isCollaborating={collabTabId === tab.id}
                viewOnly={
                  collabTabId === tab.id &&
                  collabSession?.role === "guest" &&
                  collab.role === "viewer"
                }
                onCollabChange={collabTabId === tab.id ? collab.handlers.onChange : undefined}
                onPointerUpdate={
                  collabTabId === tab.id ? collab.handlers.onPointerUpdate : undefined
                }
                libraryReturnUrl={libraryReturnUrl}
                persistLibrary={!(collabTabId === tab.id && collabSession?.role === "guest")}
                theme={resolvedTheme}
              />
            </div>
          ))}
        </div>
        <AgentPanel
          tabId={activeTabId}
          collabParticipants={
            collabSession && collabTabId === activeTabId ? collab.peers.length : 0
          }
          readOnly={activeTabIsViewer}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>
      <ConfirmCloseDialog
        open={pendingClose !== null}
        tabLabel={pendingLabel}
        onSave={handleConfirmSave}
        onDiscard={handleConfirmDiscard}
        onCancel={handleConfirmCancel}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UpdateController onBeforeRestart={flushBeforeUpdate} />
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        tabId={activeTabId}
        onOpenSettings={() => setSettingsOpen(true)}
        peers={collabSession ? collab.peers : []}
        selfName={collabUsername}
        selfRole={collab.role}
        onDenyEdit={collab.denyEdit}
        sessionTabLabel={collabTabLabel}
        onGoToSessionTab={() => collabTabId && selectTab(collabTabId)}
      />
      <JoinDialog
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        onJoin={handleJoin}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    </main>
  );
}

/**
 * The `.excalidraw` JSON for a tab: live elements plus hidden component slots (FR-69), and the
 * files they reference.
 */
function serializeSceneOf(api: ExcalidrawImperativeAPI): string {
  const elements = persistedElements(api.getSceneElementsIncludingDeleted());
  return serializeScene(
    elements,
    api.getAppState() as unknown as Record<string, unknown>,
    referencedFiles(elements, api.getFiles()) as unknown as Record<string, unknown>,
  );
}

function formatError(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}
