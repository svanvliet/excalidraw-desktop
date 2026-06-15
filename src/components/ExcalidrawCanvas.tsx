import { Excalidraw } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef } from "react";

import "@excalidraw/excalidraw/index.css";

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
  libraryReturnUrl?: string;
  /**
   * Resolved theme to apply to the editor chrome. The host app already
   * resolved "system" to a concrete light/dark value before passing it
   * in — Excalidraw only understands the two terminal values.
   */
  theme?: "light" | "dark";
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
  libraryReturnUrl,
  theme,
}: ExcalidrawCanvasProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      onApi(api);
    },
    [onApi],
  );

  // Guard against `onSceneChange` firing during the initial mount before the
  // user has actually edited anything.
  const hasMountedRef = useRef(false);
  useEffect(() => {
    hasMountedRef.current = false;
    // re-arm whenever a new scene is loaded
  }, [initialData]);

  const handleChange = useCallback(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    onSceneChange();
  }, [onSceneChange]);

  return (
    <div className="excalidraw-canvas">
      <Excalidraw
        initialData={initialData ?? undefined}
        excalidrawAPI={handleApi}
        onChange={handleChange}
        aiEnabled={aiEnabled ?? false}
        isCollaborating={isCollaborating ?? false}
        {...(libraryReturnUrl ? { libraryReturnUrl } : {})}
        {...(theme ? { theme } : {})}
      />
    </div>
  );
}
