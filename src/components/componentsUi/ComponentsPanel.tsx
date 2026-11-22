/**
 * Components tab (FR-55, D-DX10): the drawing's components (masters), the user's saved
 * components ("My components", shared by every drawing), and the Excalidraw library's items that
 * can be made into components.
 *
 *  - Click a component to place an instance in the middle of the view, or drag it onto the
 *    canvas. A saved component that isn't in this drawing yet brings its master along.
 *  - Double-click a name to rename it. Every canvas change is one undo step.
 *  - Saved components keep their images. Export writes `.excalidrawlib` (without images).
 *
 * Styling reuses Excalidraw's search-panel classes like the Layers tab.
 */
import { hashElementsVersion } from "@excalidraw/excalidraw";
import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { El } from "../../agent/scene/draft";
import { runComponentCommand } from "../../extensions/components/host";
import { masterSnapshot } from "../../extensions/components/library";
import { listComponents, type ComponentInfo } from "../../extensions/components/model";
import { removeMyComponent, renameMyComponent } from "../../lib/componentLibraryStore";
import { CloseIcon, ExportIcon, SaveIcon } from "../icons";
import {
  exportLibrary,
  goToMaster,
  makeFromLibraryItem,
  saveToMyComponents,
  useMyComponents,
} from "./commands";
import { placeInstance, placeMyComponent, setDragPayload } from "./insert";
import { renameComponent } from "./libraryCodec";
import { libraryMasterEngine, moveMasterToLibrary } from "./libraryMasters";
import { ComponentThumb } from "./thumbnail";

type Api = ExcalidrawImperativeAPI;

interface DocComponent {
  info: ComponentInfo;
  master: El[];
}

interface DocSnapshot {
  /** The drawing's components; `master` is rebuilt off-canvas when it isn't on the canvas. */
  components: DocComponent[];
  /** Every component in the drawing, library-backed ones included. */
  all: ComponentInfo[];
  files: BinaryFiles;
  dark: boolean;
}

/** Off-canvas masters rebuilt for thumbnails, reused while the component's elements are unchanged. */
const rebuilt = new Map<string, { key: string; els: El[] }>();

function offCanvasMaster(elements: readonly El[], info: ComponentInfo, byId: Map<string, El>) {
  const members = info.instances.flatMap((i) => i.ids.map((id) => byId.get(id)!));
  const key = String(hashElementsVersion(members));
  const hit = rebuilt.get(info.componentId);
  if (hit?.key === key) return hit.els;
  let els: El[];
  try {
    els = masterSnapshot(elements, info.componentId).elements;
  } catch {
    els = info.instances[0]?.ids.map((id) => byId.get(id)!) ?? [];
  }
  rebuilt.set(info.componentId, { key, els });
  if (rebuilt.size > 200) rebuilt.delete(rebuilt.keys().next().value!);
  return els;
}

function docSnapshot(api: Api): DocSnapshot {
  const elements = api.getSceneElements() as readonly El[];
  const byId = new Map(elements.map((e) => [e.id, e]));
  const all = listComponents(elements);
  const components = all
    // Components that only live nested inside others are reached through those.
    .filter((c) => c.masterGroupId || c.instances.some((i) => !i.parent))
    .map((info) => ({
      info,
      master: info.masterGroupId
        ? info.masterIds.map((id) => byId.get(id)).filter((e): e is El => !!e)
        : offCanvasMaster(elements, info, byId),
    }));
  return { components, all, files: api.getFiles(), dark: api.getAppState().theme === "dark" };
}

/** The drawing's components, refreshed when elements or the theme change (once per frame). */
function useDocComponents(api: Api): DocSnapshot {
  const [snap, setSnap] = useState(() => docSnapshot(api));
  useEffect(() => {
    let lastKey = "";
    let frame = 0;
    const refresh = () => {
      frame = 0;
      const key = `${hashElementsVersion(api.getSceneElements())}|${api.getAppState().theme}|${
        Object.keys(api.getFiles()).length
      }`;
      if (key === lastKey) return;
      lastKey = key;
      setSnap(docSnapshot(api));
    };
    refresh();
    const off = api.onChange(() => {
      if (!frame) frame = requestAnimationFrame(refresh);
    });
    return () => {
      off();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [api]);
  return snap;
}

export function ComponentsPanel({
  api,
  readOnly,
  canSave,
  libraryItems,
}: {
  api: Api;
  /** View mode: no placing, renaming or deleting. */
  readOnly?: boolean;
  /** This tab may write My components (off for live-collab guests). */
  canSave?: boolean;
  libraryItems: LibraryItems;
}) {
  const doc = useDocComponents(api);
  const mine = useMyComponents();
  const [renaming, setRenaming] = useState<string | null>(null);
  const edit = !readOnly;
  const save = edit && !!canSave;
  const inDoc = new Set(doc.all.map((c) => c.componentId));
  const usable = libraryItems.filter((i) => i.elements.some((e) => !e.isDeleted));

  return (
    <div className="layer-ui__search desktop-components" data-testid="components-panel">
      <div className="layer-ui__search-header desktop-layers__header">
        <span className="desktop-layers__title">Components</span>
      </div>
      <div className="layer-ui__search-result-container desktop-components__body">
        <Section title="In this drawing" testId="components-doc">
          {doc.components.length === 0 ? (
            <Empty>Select shapes and choose Create component (Alt/Option + Cmd/Ctrl + K).</Empty>
          ) : (
            doc.components.map((c) => {
              const name = c.info.name ?? "Component";
              const n = c.info.instances.length;
              return (
                <Row
                  key={c.info.componentId}
                  testId={`component-doc-${c.info.componentId}`}
                  name={name}
                  detail={`${n} instance${n === 1 ? "" : "s"}`}
                  thumb={
                    <ComponentThumb
                      thumbKey={`doc:${c.info.componentId}`}
                      elements={c.master}
                      files={doc.files}
                      dark={doc.dark}
                    />
                  }
                  hint={edit ? "Click or drag to place an instance" : "Show the master"}
                  onActivate={() =>
                    edit
                      ? placeInstance(api, c.info.componentId)
                      : goToMaster(api, c.info.componentId)
                  }
                  drag={edit ? { source: "doc", id: c.info.componentId } : undefined}
                  renaming={renaming === `doc:${c.info.componentId}`}
                  onStartRename={edit ? () => setRenaming(`doc:${c.info.componentId}`) : undefined}
                  onRename={(next) => {
                    setRenaming(null);
                    if (next === null || next.trim() === name) return;
                    runComponentCommand(api, (d) => renameComponent(d, c.info.componentId, next));
                  }}
                >
                  <RowButton
                    label={c.info.masterGroupId ? `Go to the master of ${name}` : `Go to ${name}`}
                    onClick={() => goToMaster(api, c.info.componentId)}
                  >
                    <TargetIcon />
                  </RowButton>
                  {save && (
                    <RowButton
                      label={`Save ${name} to My components`}
                      onClick={() => void saveToMyComponents(api, c.info.componentId)}
                    >
                      <SaveIcon size={16} />
                    </RowButton>
                  )}
                  {save && libraryMasterEngine() && c.info.masterGroupId && (
                    <RowButton
                      label={`Move the master of ${name} to My components (off the canvas)`}
                      onClick={() => void moveMasterToLibrary(api, c.info.componentId)}
                    >
                      <MoveToLibraryIcon />
                    </RowButton>
                  )}
                </Row>
              );
            })
          )}
        </Section>

        <Section
          title="My components"
          testId="components-mine"
          action={
            mine.length > 0 && (
              <RowButton
                label="Export My components as .excalidrawlib"
                onClick={() => void exportLibrary(api, mine)}
              >
                <ExportIcon size={16} />
              </RowButton>
            )
          }
        >
          {mine.length === 0 ? (
            <Empty>
              {save
                ? "Save a component here to reuse it in any drawing."
                : "Your saved components appear here."}
            </Empty>
          ) : (
            mine.map((m) => (
              <Row
                key={m.id}
                testId={`component-mine-${m.id}`}
                name={m.name}
                detail={inDoc.has(m.id) ? "In this drawing" : ""}
                thumb={
                  <ComponentThumb
                    thumbKey={`mine:${m.id}:${m.updated}`}
                    elements={m.elements}
                    files={m.files}
                    dark={doc.dark}
                  />
                }
                hint={edit ? "Click or drag to place it in this drawing" : ""}
                onActivate={edit ? () => placeMyComponent(api, m) : undefined}
                drag={edit ? { source: "mine", id: m.id } : undefined}
                renaming={renaming === `mine:${m.id}`}
                onStartRename={save ? () => setRenaming(`mine:${m.id}`) : undefined}
                onRename={(next) => {
                  setRenaming(null);
                  if (next !== null && next.trim() !== m.name) void renameMyComponent(m.id, next);
                }}
              >
                {save && (
                  <RowButton
                    label={`Remove ${m.name} from My components`}
                    onClick={() => void removeMyComponent(m.id)}
                  >
                    <CloseIcon size={16} />
                  </RowButton>
                )}
              </Row>
            ))
          )}
        </Section>

        {edit && usable.length > 0 && (
          <Section title="From your library" testId="components-library">
            {usable.map((item, i) => {
              const name = item.name?.trim() || `Library item ${i + 1}`;
              return (
                <Row
                  key={item.id}
                  testId={`component-library-${item.id}`}
                  name={name}
                  detail=""
                  thumb={
                    <ComponentThumb
                      thumbKey={`lib:${item.id}`}
                      elements={item.elements as readonly El[]}
                      dark={doc.dark}
                    />
                  }
                  hint=""
                >
                  <button
                    type="button"
                    className="desktop-components__make"
                    data-testid={`component-make-${item.id}`}
                    onClick={() => void makeFromLibraryItem(api, { ...item, name }, save)}
                  >
                    Make component
                  </button>
                </Row>
              );
            })}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  testId,
  action,
  children,
}: {
  title: string;
  testId: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="desktop-components__section" data-testid={testId} aria-label={title}>
      <div className="desktop-components__section-title">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <div className="desktop-layers__empty">{children}</div>
);

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="desktop-layers__lock desktop-components__btn"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function Row({
  testId,
  name,
  detail,
  thumb,
  hint,
  onActivate,
  drag,
  renaming,
  onStartRename,
  onRename,
  children,
}: {
  testId: string;
  name: string;
  detail: string;
  thumb: ReactNode;
  hint: string;
  onActivate?: () => void;
  drag?: { source: "doc" | "mine"; id: string };
  renaming?: boolean;
  onStartRename?: () => void;
  onRename?: (name: string | null) => void;
  children?: ReactNode;
}) {
  return (
    <div
      className="layer-ui__result-item desktop-components__row"
      data-testid={testId}
      role={onActivate ? "button" : undefined}
      tabIndex={onActivate ? 0 : undefined}
      title={hint || undefined}
      draggable={!!drag && !renaming}
      onDragStart={drag ? (e) => setDragPayload(e, drag) : undefined}
      onClick={renaming ? undefined : onActivate}
      onDoubleClick={(e) => {
        if (!onStartRename) return;
        e.preventDefault();
        onStartRename();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || renaming) return;
        if ((e.key === "Enter" || e.key === " ") && onActivate) {
          e.preventDefault();
          onActivate();
        } else if (e.key === "F2" && onStartRename) {
          e.preventDefault();
          onStartRename();
        }
      }}
    >
      {thumb}
      <span className="desktop-components__text">
        {renaming && onRename ? (
          <RenameInput initial={name} onDone={onRename} />
        ) : (
          <span className="desktop-components__name" title={name}>
            {name}
          </span>
        )}
        {detail && <span className="desktop-components__detail">{detail}</span>}
      </span>
      {children}
    </div>
  );
}

function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      className="desktop-layers__rename"
      defaultValue={initial}
      aria-label="Component name"
      maxLength={80}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/** Arrow into a tray: "move to My components". */
const MoveToLibraryIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3v11M8 10l4 4 4-4" />
    <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </svg>
);

/** Crosshair: "go to". Drawn like the sidebar icons. */
const TargetIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </svg>
);
