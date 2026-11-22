/**
 * Master-edit overlay (FR-66, D-DX20): a temporary canvas over the drawing where a component's
 * master is edited in place, the way Sketch does it. The master is rebuilt off the drawing
 * (it never sits on the canvas) and shown where the instance you opened it from is, with the
 * rest of the drawing around it as dimmed, locked copies for context. Done applies the edit to
 * every instance as one undo step (and, when the component is linked to My components, updates
 * it there too); Cancel, or Esc once nothing else wants it, leaves the drawing untouched.
 */
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ToolError, type El } from "../../agent/scene/draft";
import {
  applyComponentMasterEdit,
  componentsOnDuplicate,
  componentsReactor,
  installComponents,
  tagFor,
  uninstallComponents,
} from "../../extensions/components";
import {
  canSaveMyComponents,
  getMyComponents,
  putMyComponent,
} from "../../lib/componentLibraryStore";
import { log } from "../../lib/logger";
import { PropertiesPanelHost } from "../propertiesPanel/PropertiesPanelHost";
import { PANEL_SECTIONS } from "../propertiesPanel/sections";
import { librarySourceOf, masterToEntry } from "./libraryCodec";
import {
  buildMasterEditScene,
  componentKey,
  editedMaster,
  filesOf,
  masterChanged,
  type MasterEditScene,
} from "./masterEditScene";
import {
  registerMasterEditorApi,
  useMasterEditStore,
  type MasterEditSession,
} from "./masterEditStore";

type Api = ExcalidrawImperativeAPI;

declare global {
  interface Window {
    /** The open master editor's API, only when the e2e flag is set. */
    __masterEditor?: Api;
  }
}

const E2E_FLAG_KEY = "excalidraw-desktop:e2e";

/** The My components entry the component is linked to, if this machine has it. */
function linkedEntryId(elements: readonly El[], scene: MasterEditScene): string | null {
  const cid = scene.componentId;
  const el = elements.find((e) => !e.isDeleted && tagFor(e, cid)?.role === "instance");
  const id = librarySourceOf(el)?.libraryId ?? cid;
  return getMyComponents().some((c) => c.id === id) ? id : null;
}

export interface MasterEditorProps {
  session: MasterEditSession;
  theme?: "light" | "dark";
  onPointerUpdate?: ExcalidrawProps["onPointerUpdate"];
}

export function MasterEditor({ session, theme, onPointerUpdate }: MasterEditorProps) {
  const mainApi = session.api;
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [api, setApi] = useState<Api | null>(null);
  const main = useMemo(() => mainApi.getAppState(), [mainApi]);
  const scene = useMemo(
    () =>
      buildMasterEditScene(
        mainApi.getSceneElements() as readonly El[],
        mainApi.getFiles(),
        session.instanceGroupId,
        {
          scrollX: main.scrollX,
          scrollY: main.scrollY,
          zoom: main.zoom.value,
          width: main.width,
          height: main.height,
        },
      ),
    [mainApi, session.instanceGroupId, main],
  );
  const linkedId = useMemo(
    () => (canSaveMyComponents() ? linkedEntryId(mainApi.getSceneElements() as El[], scene) : null),
    [mainApi, scene],
  );
  const [updateLibrary, setUpdateLibrary] = useState(true);

  // Viewport parity: the overlay's canvas sits below the header, so shift its scroll by the
  // difference in screen offset to keep every scene point on the same pixel.
  const [offset, setOffset] = useState<{ dx: number; dy: number } | null>(null);
  useLayoutEffect(() => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (r) setOffset({ dx: r.left - main.offsetLeft, dy: r.top - main.offsetTop });
  }, [main]);

  const initialData = useMemo(() => {
    if (!offset) return null;
    const z = main.zoom.value;
    return {
      elements: scene.elements,
      files: scene.files,
      appState: {
        scrollX: main.scrollX - offset.dx / z,
        scrollY: main.scrollY - offset.dy / z,
        zoom: main.zoom,
        viewBackgroundColor: main.viewBackgroundColor,
        gridModeEnabled: main.gridModeEnabled,
        gridSize: main.gridSize,
        objectsSnapModeEnabled: main.objectsSnapModeEnabled,
        selectedElementIds: Object.fromEntries(scene.masterIds.map((id) => [id, true])),
        selectedGroupIds: { [scene.masterGroupId]: true },
      } as Partial<AppState>,
      scrollToContent: false,
    };
  }, [offset, scene, main]);

  const handleApi = useCallback((a: Api) => {
    registerMasterEditorApi(a);
    installComponents(a);
    setApi(a);
    try {
      if (localStorage.getItem(E2E_FLAG_KEY) === "1") window.__masterEditor = a;
    } catch {
      // storage unavailable
    }
  }, []);
  useEffect(() => {
    if (!api) return;
    return () => {
      uninstallComponents(api);
      if (window.__masterEditor === api) delete window.__masterEditor;
    };
  }, [api]);

  const close = useCallback(() => {
    // Clicking the overlay closes an undocked main sidebar; put it back.
    const s = mainApi.getAppState();
    if (session.sidebar && s.openSidebar?.name !== session.sidebar.name)
      mainApi.updateScene({ appState: { openSidebar: session.sidebar } });
    // Excalidraw's shortcuts follow focus; hand it back to the drawing so ⌘Z works right away.
    const main = canvasRef.current
      ?.closest(".canvas-slot")
      ?.querySelector<HTMLElement>(".excalidraw-canvas:not(.master-edit__canvas) .excalidraw");
    useMasterEditStore.getState().close();
    main?.focus({ preventScroll: true });
  }, [mainApi, session]);

  const done = useCallback(() => {
    if (!api) return;
    componentsReactor(api)?.flush();
    const overlay = api.getSceneElementsIncludingDeleted() as readonly El[];
    if (!masterChanged(scene, overlay)) return close();
    const edited = editedMaster(scene, overlay);
    if (!edited.length) {
      api.setToast({ message: "A component needs at least one element", duration: 3000 });
      return;
    }
    const cid = scene.componentId;
    const changedMeanwhile =
      componentKey(mainApi.getSceneElements() as readonly El[], cid) !== scene.sourceKey;
    try {
      if (!applyComponentMasterEdit(mainApi, cid, edited, filesOf(edited, api.getFiles()))) {
        api.setToast({ message: "Couldn't apply the edit to this drawing.", duration: 3000 });
        return;
      }
    } catch (err) {
      if (err instanceof ToolError) api.setToast({ message: err.message, duration: 3000 });
      else log.error("components: applying the master edit failed", err);
      return;
    }
    const n = scene.instanceCount;
    let message = `Updated ${n} ${n === 1 ? "instance" : "instances"} of "${scene.name}"`;
    if (changedMeanwhile)
      message = `"${scene.name}" changed while you were editing; your edit replaced it`;
    if (linkedId && updateLibrary) {
      const entry = {
        ...masterToEntry(mainApi.getSceneElements() as readonly El[], mainApi.getFiles(), cid),
        id: linkedId,
      };
      void putMyComponent(entry)
        .then((ok) => {
          if (!ok) mainApi.setToast({ message: "Couldn't update it in My components." });
        })
        .catch((err) => log.error("components: updating My components failed", err));
      message += " and in My components";
    }
    mainApi.setToast({ message, duration: 3000 });
    close();
  }, [api, mainApi, scene, linkedId, updateLibrary, close]);

  // Layered Esc: Excalidraw keeps its own uses (text edit, dialogs, a drawing tool); then exit
  // group editing; then deselect; only then Cancel. Cmd/Ctrl+Enter is Done.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (!api) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      done();
      return;
    }
    if (e.key !== "Escape") return;
    const s = api.getAppState();
    if (
      s.editingTextElement ||
      s.openDialog ||
      s.openPopup ||
      s.openSidebar ||
      s.activeTool.type !== "selection" ||
      s.newElement ||
      s.multiElement
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    if (s.editingGroupId) api.updateScene({ appState: { editingGroupId: null } });
    else if (Object.values(s.selectedElementIds).some(Boolean))
      api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} } });
    else close();
  };
  // Keys typed here must not reach the main editor's document listeners (an undocked main
  // sidebar closes on any document Escape).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") e.stopPropagation();
  };

  const n = scene.instanceCount;
  return (
    <div
      className="master-edit"
      data-testid="master-edit"
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
    >
      <div
        className="master-edit__bar"
        role="toolbar"
        aria-label="Editing component"
        data-testid="master-edit-header"
      >
        <span className="master-edit__title">
          Editing component “{scene.name}”
          <span className="master-edit__meta">
            {" "}
            · changes apply to {n} {n === 1 ? "instance" : "instances"}
          </span>
        </span>
        {linkedId && (
          <label className="master-edit__check">
            <input
              type="checkbox"
              data-testid="master-edit-update-library"
              checked={updateLibrary}
              onChange={(e) => setUpdateLibrary(e.target.checked)}
            />
            Also update in My components
          </label>
        )}
        <button type="button" className="icon-btn" data-testid="master-edit-cancel" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--primary"
          data-testid="master-edit-done"
          title="Done (Cmd/Ctrl + Enter)"
          onClick={done}
        >
          Done
        </button>
      </div>
      <div ref={canvasRef} className="excalidraw-canvas master-edit__canvas">
        {initialData && (
          <Excalidraw
            initialData={initialData}
            excalidrawAPI={handleApi}
            autoFocus
            onDuplicate={componentsOnDuplicate}
            {...(onPointerUpdate ? { onPointerUpdate } : {})}
            {...(theme ? { theme } : {})}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                saveAsImage: false,
                export: false,
                clearCanvas: false,
              },
            }}
          >
            <MainMenu>
              <MainMenu.DefaultItems.ToggleTheme />
              <MainMenu.DefaultItems.Help />
            </MainMenu>
          </Excalidraw>
        )}
        {api && <PropertiesPanelHost api={api} container={canvasRef} sections={PANEL_SECTIONS} />}
      </div>
      <div className="master-edit__frame" aria-hidden />
    </div>
  );
}

/** Mounts the master editor when `api`'s editor has the open session. */
export function MasterEditorHost({
  api,
  theme,
  onPointerUpdate,
}: {
  api: Api | null;
} & Omit<MasterEditorProps, "session">) {
  const session = useMasterEditStore((s) => s.session);
  if (!api || session?.api !== api) return null;
  return (
    <MasterEditor
      key={session.instanceGroupId}
      session={session}
      theme={theme}
      onPointerUpdate={onPointerUpdate}
    />
  );
}
