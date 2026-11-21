import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";

import "@excalidraw/excalidraw/index.css";
import { PropertiesPanelHost } from "./propertiesPanel/PropertiesPanelHost";
import { PANEL_SECTIONS } from "./propertiesPanel/sections";
import { enableDraggablePropertiesPanel } from "../lib/draggablePropertiesPanel";
import { refreshTextElements, watchFontLoads } from "../lib/fontRefresh";
import { sceneContentKey } from "../lib/sceneContent";

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
    };
  }
}

/** Same flag as GuestApp's E2E_FLAG_KEY. */
const E2E_FLAG_KEY = "excalidraw-desktop:e2e";

function exposeForE2e(api: ExcalidrawImperativeAPI): void {
  try {
    if (localStorage.getItem(E2E_FLAG_KEY) !== "1") return;
    window.__canvas = api;
    void import("../agent/sceneTools").then(({ runSceneTool }) => {
      window.__e2e = { convertToExcalidrawElements, runSceneTool };
    });
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
  theme,
  onCollabChange,
  onPointerUpdate,
}: ExcalidrawCanvasProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
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

  return (
    <div ref={canvasRef} className="excalidraw-canvas">
      <Excalidraw
        initialData={initialData ?? undefined}
        excalidrawAPI={handleApi}
        onChange={handleChange}
        aiEnabled={aiEnabled ?? false}
        isCollaborating={isCollaborating ?? false}
        // `undefined` (not false) hands view mode back to the user when promoted.
        viewModeEnabled={viewOnly ? true : undefined}
        {...(onPointerUpdate ? { onPointerUpdate } : {})}
        {...(libraryReturnUrl ? { libraryReturnUrl } : {})}
        {...(theme ? { theme } : {})}
      />
      {api && !viewOnly && (
        <PropertiesPanelHost api={api} container={canvasRef} sections={PANEL_SECTIONS} />
      )}
    </div>
  );
}
