/**
 * Layers tab: the scene as a frames → groups → elements tree (see `src/layers/layers.ts`).
 * Click a row to select it and scroll to it; double-click (or F2) to rename; the lock button
 * toggles locking. Every rename / lock is one undo step. Read-only in view mode.
 *
 * Styling reuses Excalidraw's own search-panel classes (`layer-ui__search*`,
 * `layer-ui__result-item`), so it follows the editor's light / dark theme.
 */
import { CaptureUpdateAction, hashElementsVersion } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Draft, type El } from "../../agent/scene/draft";
import { commitUndoable } from "../../agent/scene/turns";
import { applyLayerEdit, buildLayerTree, type LayerNode } from "../../layers/layers";
import { log } from "../../lib/logger";
import { ChevronRightIcon, LockIcon, UnlockIcon } from "../icons";

interface Snapshot {
  tree: LayerNode[];
  selectedIds: Record<string, true>;
  selectedGroupIds: Record<string, boolean>;
}

function snapshotOf(api: ExcalidrawImperativeAPI): Snapshot {
  const state = api.getAppState();
  return {
    tree: buildLayerTree(api.getSceneElementsIncludingDeleted() as readonly El[]),
    selectedIds: state.selectedElementIds as Record<string, true>,
    selectedGroupIds: state.selectedGroupIds,
  };
}

/** Rebuild the tree when elements or the selection change, at most once per frame. */
function useLayerSnapshot(api: ExcalidrawImperativeAPI): Snapshot {
  const [snap, setSnap] = useState(() => snapshotOf(api));
  useEffect(() => {
    let lastKey = "";
    let frame = 0;
    const refresh = () => {
      frame = 0;
      const state = api.getAppState();
      const key = [
        hashElementsVersion(api.getSceneElementsIncludingDeleted()),
        Object.keys(state.selectedElementIds).join(","),
        Object.keys(state.selectedGroupIds).join(","),
      ].join("|");
      if (key === lastKey) return;
      lastKey = key;
      setSnap(snapshotOf(api));
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

function selectLayer(api: ExcalidrawImperativeAPI, node: LayerNode) {
  const byId = new Map(api.getSceneElements().map((e) => [e.id, e as El]));
  const ids = node.kind === "group" ? node.elementIds : [node.id];
  const els = ids.map((id) => byId.get(id)).filter((e): e is El => !!e);
  if (!els.length) return;
  // Selecting inside a group means "editing" its parent group, as when double-clicking in.
  let editingGroupId: string | null = null;
  if (node.kind === "group") {
    const chain = els[0].groupIds;
    editingGroupId = chain[chain.indexOf(node.id) + 1] ?? null;
  } else if (node.kind === "element") {
    editingGroupId = els[0].groupIds[0] ?? null;
  }
  api.updateScene({
    appState: {
      selectedElementIds: Object.fromEntries(els.map((e) => [e.id, true as const])),
      selectedGroupIds: node.kind === "group" ? { [node.id]: true } : {},
      editingGroupId,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  api.scrollToContent(els, { animate: true });
}

function editLayer(
  api: ExcalidrawImperativeAPI,
  id: string,
  edit: { name?: string; locked?: boolean },
) {
  const draft = new Draft(api.getSceneElementsIncludingDeleted() as readonly El[]);
  try {
    applyLayerEdit(draft, id, edit);
  } catch (err) {
    log.warn("layers: edit failed", err);
    return;
  }
  if (!draft.changed.size) return;
  commitUndoable(api, draft);
}

function isSelected(node: LayerNode, snap: Snapshot): boolean {
  return node.kind === "group" ? !!snap.selectedGroupIds[node.id] : !!snap.selectedIds[node.id];
}

export function LayersPanel({
  api,
  readOnly,
}: {
  api: ExcalidrawImperativeAPI;
  readOnly?: boolean;
}) {
  const snap = useLayerSnapshot(api);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const rows: Array<{ node: LayerNode; depth: number }> = [];
  const walk = (nodes: readonly LayerNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (!collapsed.has(node.id)) walk(node.children, depth + 1);
    }
  };
  walk(snap.tree, 0);

  return (
    <div className="layer-ui__search desktop-layers" data-testid="layers-panel">
      <div className="layer-ui__search-header desktop-layers__header">
        <span className="desktop-layers__title">Layers</span>
      </div>
      {rows.length === 0 ? (
        <div className="desktop-layers__empty">Nothing on the canvas yet.</div>
      ) : (
        <div className="layer-ui__search-result-container desktop-layers__list" role="tree">
          {rows.map(({ node, depth }) => (
            <LayerRow
              key={node.id}
              node={node}
              depth={depth}
              selected={isSelected(node, snap)}
              expanded={node.children.length ? !collapsed.has(node.id) : undefined}
              renaming={renaming === node.id}
              readOnly={!!readOnly}
              onSelect={() => selectLayer(api, node)}
              onToggle={() => toggleCollapsed(node.id)}
              onStartRename={() => !readOnly && setRenaming(node.id)}
              onRename={(name) => {
                setRenaming(null);
                // Confirming the untouched default label isn't a rename.
                if (name === null || name.trim() === (node.name ?? node.label)) return;
                editLayer(api, node.id, { name });
              }}
              onLock={() => editLayer(api, node.id, { locked: !node.locked })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  node: LayerNode;
  depth: number;
  selected: boolean;
  expanded: boolean | undefined;
  renaming: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onStartRename: () => void;
  /** `null` cancels. */
  onRename: (name: string | null) => void;
  onLock: () => void;
}

function LayerRow({
  node,
  depth,
  selected,
  expanded,
  renaming,
  readOnly,
  onSelect,
  onToggle,
  onStartRename,
  onRename,
  onLock,
}: RowProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    } else if (e.key === "F2") {
      e.preventDefault();
      onStartRename();
    } else if (
      (e.key === "ArrowRight" && expanded === false) ||
      (e.key === "ArrowLeft" && expanded)
    ) {
      e.preventDefault();
      onToggle();
    }
  };
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={expanded}
      tabIndex={0}
      className={`layer-ui__result-item desktop-layers__row${selected ? " active" : ""}${
        node.locked ? " desktop-layers__row--locked" : ""
      }`}
      // Tree depth drives the indent in CSS.
      style={{ "--layer-depth": depth } as CSSProperties}
      data-layer-id={node.id}
      data-layer-kind={node.kind}
      onClick={onSelect}
      onDoubleClick={onStartRename}
      onKeyDown={onKeyDown}
    >
      {expanded !== undefined ? (
        <button
          type="button"
          className="desktop-layers__twisty"
          data-expanded={expanded}
          aria-label={expanded ? "Collapse" : "Expand"}
          title={expanded ? "Collapse" : "Expand"}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <ChevronRightIcon />
        </button>
      ) : (
        <span className="desktop-layers__twisty" aria-hidden="true" />
      )}
      {renaming ? (
        <RenameInput initial={node.name ?? node.label} onDone={onRename} />
      ) : (
        <span className="preview-text desktop-layers__label" title={node.label}>
          {node.label}
        </span>
      )}
      <span className="desktop-layers__kind">{node.kind === "element" ? "" : node.kind}</span>
      {readOnly ? (
        node.locked && (
          <span className="desktop-layers__lock" aria-label="Locked" title="Locked">
            <LockIcon />
          </span>
        )
      ) : (
        <button
          type="button"
          className="desktop-layers__lock"
          data-locked={node.locked}
          aria-label={`${node.locked ? "Unlock" : "Lock"} ${node.label}`}
          aria-pressed={node.locked}
          title={node.locked ? "Unlock" : "Lock"}
          onClick={(e) => {
            e.stopPropagation();
            onLock();
          }}
        >
          {node.locked ? <LockIcon /> : <UnlockIcon />}
        </button>
      )}
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
      aria-label="Layer name"
      maxLength={200}
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
