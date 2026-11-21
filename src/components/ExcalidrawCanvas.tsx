import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "@excalidraw/excalidraw/index.css";
import { ComponentsIcon, LayersIcon } from "./icons";
import { ComponentsPanel } from "./componentsUi/ComponentsPanel";
import { handleComponentDragOver, handleComponentDrop } from "./componentsUi/insert";
import { MasterEditBanner } from "./componentsUi/MasterEditBanner";
import { PropertiesPanelHost } from "./propertiesPanel/PropertiesPanelHost";
import { PANEL_SECTIONS } from "./propertiesPanel/sections";
import { LayersPanel } from "./sidebar/LayersPanel";
import { SidebarTabs, type SidebarTabDef } from "./sidebar/SidebarTabs";
import { enableDraggablePropertiesPanel } from "../lib/draggablePropertiesPanel";
import { refreshTextElements, watchFontLoads } from "../lib/fontRefresh";
import { sceneContentKey } from "../lib/sceneContent";
import { autoLayoutCanvas, isAutoLayoutShortcut } from "../layout/canvasAction";
import {
  type LibrarySink,
  loadLibrary,
  registerLibrarySink,
  saveLibrary,
} from "../lib/libraryStore";
import { log } from "../lib/logger";
import {
  componentsOnDuplicate,
  installComponents,
  handleComponentShortcut,
  reseedComponents,
  uninstallComponents,
} from "../extensions/components";

export interface ExcalidrawCanvasProps {
  /**
   * Scene to seed the editor with. Keyed externally so passing a new `key`
   * is how the parent forces a fresh editor instance (e.g. after opening a
   * different file).
   */
  initialData?: ExcalidrawInitialDataState | null;
  /**
   * Receives the Excalidraw imperative API once the editor mounts. The parent
   * keeps the reference so it can read the current scene for save/export.
   */
  onApi: (api: ExcalidrawImperativeAPI) => void;
  /**
   * Fired whenever the user changes the scene (elements, app state, or files).
   * Used to flip the document's dirty flag.
   */
  onSceneChange: () => void;
  /**
   * Online-feature toggles. Default to off (omit = off). Passing these
   * unconditionally is the privacy boundary — the parent should never
   * read settings inside this component.
   */
  aiEnabled?: boolean;
  isCollaborating?: boolean;
  /** Force read-only (collab viewers). */
  viewOnly?: boolean;
  libraryReturnUrl?: string;
  /**
   * Save this editor's personal-library changes to app data (libraryStore.ts). Off for
   * live-collab guest tabs; they still show the stored library but never write it.
   */
  persistLibrary?: boolean;
  /**
   * Resolved theme to apply to the editor chrome. The host app already
   * resolved "system" to a concrete light/dark value before passing it
   * in — Excalidraw only understands the two terminal values.
   */
  theme?: "light" | "dark";
  /**
   * Live-collaboration passthroughs. Receive every raw Excalidraw callback
   * (no mount guard) so the collab session can broadcast scene and pointer
   * updates. Omit when the tab isn't in a session.
   */
  onCollabChange?: ExcalidrawProps["onChange"];
  onPointerUpdate?: ExcalidrawProps["onPointerUpdate"];
}

declare global {
  interface Window {
    /** The last mounted editor's API, only when the e2e flag is set (see GuestApp's `__guest`). */
    __canvas?: ExcalidrawImperativeAPI;
    /** Scene helpers for e2e specs, same flag: build elements and run agent canvas tools. */
    __e2e?: {
      convertToExcalidrawElements: typeof convertToExcalidrawElements;
      runSceneTool: typeof import("../agent/sceneTools").runSceneTool;
      /** Whether the engine's library-backed master primitives are present (docs/components.md). */
      libraryMasters: boolean;
    };
  }
}

/** Same flag as GuestApp's E2E_FLAG_KEY. */
const E2E_FLAG_KEY = "excalidraw-desktop:e2e";

function exposeForE2e(api: ExcalidrawImperativeAPI): void {
  try {
    if (localStorage.getItem(E2E_FLAG_KEY) !== "1") return;
    window.__canvas = api;
    void Promise.all([import("../agent/sceneTools"), import("./componentsUi/libraryMasters")]).then(
      ([{ runSceneTool }, { libraryMasterEngine }]) => {
        window.__e2e = {
          convertToExcalidrawElements,
          runSceneTool,
          libraryMasters: libraryMasterEngine() !== null,
        };
      },
    );
  } catch {
    // storage unavailable
  }
}

/**
 * Thin wrapper around the official `@excalidraw/excalidraw` component.
 * Intentionally minimal — we let the component manage its own state and only
 * surface the two hooks the rest of the app needs.
 */
export function ExcalidrawCanvas({
  initialData,
  onApi,
  onSceneChange,
  aiEnabled,
  isCollaborating,
  viewOnly,
  libraryReturnUrl,
  persistLibrary,
  theme,
  onCollabChange,
  onPointerUpdate,
}: ExcalidrawCanvasProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      registerAutoLayoutAction(api);
      // Before onApi, so the parent can wrap this editor's collab API right away.
      installComponents(api);
      apiRef.current = api;
      setApi(api);
      onApi(api);
      exposeForE2e(api);
    },
    [onApi],
  );

  // Excalidraw's onChange also fires for selection, scroll, zoom and hover,
  // so only report a change when the saved content differs: element
  // versions, attached files, or the background color. The first callback
  // after a (re)load sets the baseline.
  const contentKeyRef = useRef<string | null>(null);
  useEffect(() => {
    contentKeyRef.current = null;
  }, [initialData]);

  // Components: a file opened into this editor starts a fresh sync baseline; stop on unmount.
  useEffect(() => {
    if (api) reseedComponents(api);
  }, [api, initialData]);
  useEffect(
    () => () => {
      if (apiRef.current) uninstallComponents(apiRef.current);
    },
    [],
  );

  const handleChange = useCallback<NonNullable<ExcalidrawProps["onChange"]>>(
    (elements, appState, files) => {
      onCollabChange?.(elements, appState, files);
      const key = sceneContentKey(elements, appState, files);
      const prev = contentKeyRef.current;
      contentKeyRef.current = key;
      if (prev !== null && prev !== key) onSceneChange();
    },
    [onSceneChange, onCollabChange],
  );

  // Personal library: seed from app data once the editor mounts, then save every change and
  // receive changes made in other tabs. Changes reported before seeding finished are ignored so
  // the editor's initial empty library never overwrites the stored one.
  const persistLibraryRef = useRef(persistLibrary ?? false);
  persistLibraryRef.current = persistLibrary ?? false;
  const librarySinkRef = useRef<LibrarySink | null>(null);
  const librarySeededRef = useRef(false);
  const [libraryItems, setLibraryItems] = useState<LibraryItems>([]);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    librarySeededRef.current = false;
    const sink: LibrarySink = { updateLibrary: (opts) => api.updateLibrary(opts) };
    librarySinkRef.current = sink;
    const unregister = registerLibrarySink(sink);
    void loadLibrary()
      .then(async (items) => {
        if (cancelled) return;
        const merged = await api.updateLibrary({ libraryItems: items, merge: true });
        if (cancelled) return;
        setLibraryItems(merged);
        librarySeededRef.current = true;
        if (persistLibraryRef.current) await saveLibrary(merged, sink);
      })
      .catch((err) => log.warn("library: couldn't load into the editor", err));
    return () => {
      cancelled = true;
      unregister();
      if (librarySinkRef.current === sink) librarySinkRef.current = null;
    };
  }, [api]);

  const handleLibraryChange = useCallback<NonNullable<ExcalidrawProps["onLibraryChange"]>>(
    (items) => {
      setLibraryItems(items);
      if (!librarySeededRef.current || !persistLibraryRef.current) return;
      void saveLibrary(items, librarySinkRef.current ?? undefined);
    },
    [],
  );

  // Text painted before its font loaded can stay in the fallback face; see fontRefresh.ts.
  useEffect(() => {
    if (!api) return;
    return watchFontLoads(
      () => refreshTextElements(api, CaptureUpdateAction.NEVER),
      typeof document !== "undefined" ? document.fonts : undefined,
    );
  }, [api, initialData]);

  useEffect(() => {
    const root = canvasRef.current;
    if (!root) return;
    return enableDraggablePropertiesPanel(root);
  }, []);

  const sidebarTabs = useMemo<SidebarTabDef[]>(
    () => [
      {
        tab: "layers",
        title: "Layers",
        icon: <LayersIcon />,
        render: () => api && <LayersPanel api={api} readOnly={viewOnly} />,
      },
      {
        tab: "components",
        title: "Components",
        icon: <ComponentsIcon />,
        render: () =>
          api && (
            <ComponentsPanel
              api={api}
              readOnly={viewOnly}
              canSave={persistLibrary ?? false}
              libraryItems={libraryItems}
            />
          ),
      },
    ],
    [api, viewOnly, persistLibrary, libraryItems],
  );

  return (
    <div
      ref={canvasRef}
      className="excalidraw-canvas"
      onKeyDownCapture={(e) => handleComponentShortcut(apiRef.current, e)}
      onDragOverCapture={(e) => handleComponentDragOver(apiRef.current, e)}
      onDropCapture={(e) => handleComponentDrop(apiRef.current, e)}
    >
      <Excalidraw
        initialData={initialData ?? undefined}
        excalidrawAPI={handleApi}
        onChange={handleChange}
        onLibraryChange={handleLibraryChange}
        onDuplicate={componentsOnDuplicate}
        aiEnabled={aiEnabled ?? false}
        isCollaborating={isCollaborating ?? false}
        // `undefined` (not false) hands view mode back to the user when promoted.
        viewModeEnabled={viewOnly ? true : undefined}
        {...(onPointerUpdate ? { onPointerUpdate } : {})}
        {...(libraryReturnUrl ? { libraryReturnUrl } : {})}
        {...(theme ? { theme } : {})}
      >
        <SidebarTabs tabs={sidebarTabs} />
      </Excalidraw>
      {api && !viewOnly && (
        <PropertiesPanelHost api={api} container={canvasRef} sections={PANEL_SECTIONS} />
      )}
      {!viewOnly && <MasterEditBanner api={api} />}
    </div>
  );
}

/**
 * Alt/Option+Shift+L → layered top-to-bottom auto-layout. Registered as an Excalidraw action
 * so the editor's own key routing applies (ignored while typing, in view mode, etc.). The
 * layout itself is async (ELK runs in a worker) and commits its own undo step, so `perform`
 * only kicks it off and returns `false` to leave the scene untouched for now.
 */
function registerAutoLayoutAction(api: ExcalidrawImperativeAPI): void {
  api.registerAction({
    // Not in Excalidraw's ActionName union; the registry is keyed by plain strings.
    name: "autoLayout" as never,
    label: "Auto-layout",
    trackEvent: false,
    keyTest: (event) => isAutoLayoutShortcut(event),
    perform: () => {
      void autoLayoutCanvas(api, "down");
      return false;
    },
  });
}
