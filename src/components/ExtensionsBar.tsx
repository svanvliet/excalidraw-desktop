/**
 * Selection-aware floating bar for desktop extensions (docs/extensions.md § "UI surface").
 * Excalidraw 0.18.1 exports no command palette and has no custom context-menu prop, so this sits
 * over the canvas just above the selection and offers each applicable extension's presets plus
 * Remove. Clicking runs the same `runExtension` the agent tools use: one undo step.
 */
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { getCommonBounds } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { extensionGroups, type ExtensionGroup } from "../extensions/groups";
import { runExtension, type ExtensionAction } from "../extensions/runner";
import { log } from "../lib/logger";
import { MaskIcon } from "./icons";

export type ExtensionsBarApi = Pick<
  ExcalidrawImperativeAPI,
  | "getSceneElements"
  | "getSceneElementsIncludingDeleted"
  | "getAppState"
  | "getFiles"
  | "updateScene"
  | "scrollToContent"
  | "addFiles"
  | "onChange"
>;

const ICONS: Record<string, ComponentType<{ size?: number }>> = { mask: MaskIcon };

/** Hidden while the user is mid-gesture or typing, and in view mode. */
function isBusy(s: AppState): boolean {
  return Boolean(
    s.viewModeEnabled ||
    s.newElement ||
    s.editingTextElement ||
    s.resizingElement ||
    s.selectedElementsAreBeingDragged ||
    s.isResizing ||
    s.isRotating ||
    s.multiElement,
  );
}

interface View {
  groups: ExtensionGroup[];
  left: number;
  top: number;
  below: boolean;
}

const GAP = 12;
const BAR_HEIGHT = 40;

function computeView(api: ExtensionsBarApi): View | null {
  const appState = api.getAppState();
  if (isBusy(appState)) return null;
  const selected = api
    .getSceneElements()
    .filter((el) => appState.selectedElementIds[el.id] && !el.isDeleted);
  if (!selected.length) return null;
  const groups = extensionGroups(selected);
  if (!groups.length) return null;
  const [minX, minY, maxX, maxY] = getCommonBounds(selected);
  const zoom = appState.zoom.value;
  const toX = (x: number) => (x + appState.scrollX) * zoom;
  const toY = (y: number) => (y + appState.scrollY) * zoom;
  const centre = (toX(minX) + toX(maxX)) / 2;
  const left = Math.min(Math.max(centre, GAP), Math.max(GAP, appState.width - GAP));
  const above = toY(minY) - GAP;
  const below = above < BAR_HEIGHT + GAP;
  const top = below ? toY(maxY) + GAP : above;
  return { groups, left: Math.round(left), top: Math.round(top), below };
}

const viewKey = (v: View | null) => JSON.stringify(v);

export function ExtensionsBar({ api }: { api: ExtensionsBarApi }) {
  const [view, setView] = useState<View | null>(() => computeView(api));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let last = viewKey(computeView(api));
    setView(computeView(api));
    return api.onChange(() => {
      const next = computeView(api);
      const key = viewKey(next);
      if (key === last) return;
      last = key;
      setView(next);
      setError(null);
    });
  }, [api]);

  const run = useCallback(
    async (group: ExtensionGroup, action: ExtensionAction) => {
      setBusy(true);
      setError(null);
      try {
        const res = await runExtension(api, group.ids, group.id, action);
        if (!res.applied.length && res.skipped.length) {
          setError(res.skipped[0]!.reason);
        }
      } catch (err) {
        log.warn(`extensions: ${group.id} ${action.kind} failed`, err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  if (!view) return null;
  return (
    <div
      className="extensions-bar"
      data-below={view.below || undefined}
      role="toolbar"
      aria-label="Extensions"
      // Only the dynamic anchor point is inline; everything else lives in index.css.
      style={{ left: view.left, top: view.top }}
    >
      {view.groups.map((g) => {
        const Icon = ICONS[g.id];
        return (
          <div key={g.id} className="extensions-bar__group" title={g.description}>
            <span className="extensions-bar__title">
              {Icon && <Icon size={14} />}
              {g.title}
            </span>
            {g.presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className="icon-btn"
                data-pressed={p.active || undefined}
                aria-pressed={p.active}
                disabled={busy}
                onClick={() => void run(g, { kind: "apply", params: p.params })}
              >
                {p.label}
              </button>
            ))}
            {g.removable && (
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                disabled={busy}
                onClick={() => void run(g, { kind: "remove" })}
              >
                Remove {g.title.toLowerCase()}
              </button>
            )}
          </div>
        );
      })}
      {error && (
        <span className="extensions-bar__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
