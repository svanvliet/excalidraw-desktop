import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { ExcalidrawCanvas } from "./components/ExcalidrawCanvas";
import { Toolbar } from "./components/Toolbar";
import { useDocumentState } from "./stores/documentStore";
import { openFile, saveFile, isAppError } from "./ipc/commands";
import { detectFormat, serializeScene } from "./lib/fileFormat";

const EXCALIDRAW_FILTERS = [{ name: "Excalidraw", extensions: ["excalidraw"] }];

export function App() {
  const { state, markOpened, markSaved, markDirty } = useDocumentState();
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  // `sceneKey` is bumped whenever we load a new file, which forces Excalidraw
  // to remount with the new initialData rather than ignoring the prop change.
  const [sceneKey, setSceneKey] = useState(0);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
  }, []);

  const handleOpen = useCallback(async () => {
    setError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: EXCALIDRAW_FILTERS,
      });
      if (typeof selected !== "string") return;
      const opened = await openFile(selected);
      const detected = detectFormat(opened.contents);
      if (detected.kind !== "excalidraw-json" || !detected.parsed) {
        setError(`Not a valid Excalidraw file: ${detected.reason ?? "unknown format"}`);
        return;
      }
      setInitialData({
        elements: detected.parsed.elements as ExcalidrawInitialDataState["elements"],
        appState: detected.parsed.appState as ExcalidrawInitialDataState["appState"],
        files: detected.parsed.files as ExcalidrawInitialDataState["files"],
      });
      setSceneKey((k) => k + 1);
      markOpened(opened.path);
    } catch (e) {
      setError(formatError(e));
    }
  }, [markOpened]);

  const writeSceneTo = useCallback(async (path: string) => {
    const api = apiRef.current;
    if (!api) throw new Error("editor is not ready yet");
    const contents = serializeScene(
      api.getSceneElements(),
      api.getAppState() as unknown as Record<string, unknown>,
      api.getFiles() as unknown as Record<string, unknown>,
    );
    await saveFile(path, contents);
  }, []);

  const handleSave = useCallback(async () => {
    setError(null);
    try {
      if (state.path) {
        await writeSceneTo(state.path);
        markSaved(state.path);
      } else {
        await handleSaveAsInternal();
      }
    } catch (e) {
      setError(formatError(e));
    }
    // handleSaveAsInternal is declared below; including it in deps would create
    // a TDZ-style ordering issue. Safe because both are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.path, writeSceneTo, markSaved]);

  const handleSaveAsInternal = useCallback(async () => {
    const chosen = await saveDialog({
      defaultPath: state.path ?? "untitled.excalidraw",
      filters: EXCALIDRAW_FILTERS,
    });
    if (typeof chosen !== "string") return;
    await writeSceneTo(chosen);
    markSaved(chosen);
  }, [state.path, writeSceneTo, markSaved]);

  const handleSaveAs = useCallback(async () => {
    setError(null);
    try {
      await handleSaveAsInternal();
    } catch (e) {
      setError(formatError(e));
    }
  }, [handleSaveAsInternal]);

  // Auto-dismiss errors after a short window so a transient hiccup doesn't
  // leave a stale banner up forever.
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(id);
  }, [error]);

  return (
    <main className="app-shell">
      <Toolbar
        documentPath={state.path}
        dirty={state.dirty}
        onOpen={handleOpen}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
      />
      {error ? (
        <div className="app-shell__error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="app-shell__canvas">
        <ExcalidrawCanvas
          key={sceneKey}
          initialData={initialData}
          onApi={handleApi}
          onSceneChange={markDirty}
        />
      </div>
    </main>
  );
}

function formatError(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}
