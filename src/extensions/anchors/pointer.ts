/**
 * Face-centre snapping while the user drags an arrow end (D-DX15, FR-61). Excalidraw 0.18.1 has
 * no endpoint-drag hook, so this listens to the imperative API's pointer emitters:
 *
 * - pointer-down (after Excalidraw handled it): note which arrow end is being dragged (the
 *   linear editor's clicked point is index 0 or the last one) or that a new arrow is being drawn,
 *   suspend that arrow in the anchors rule, and publish the drag to the snap-dot overlay;
 * - pointer-up (after Excalidraw bound or unbound the end): if the end lies within
 *   {@link SNAP_TOLERANCE_PX} of a face midpoint or centre, snap, bind and pin it, else clear its
 *   pin. Writes are in-place `mutateElement`s, so they join the gesture's own undo step.
 *
 * Holding Cmd/Ctrl (Excalidraw's own "don't bind" modifier) bypasses the snap.
 */
import { CaptureUpdateAction, mutateElement } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { isElbowArrow } from "../../lib/elbowAnchors";
import {
  absolutePoints,
  type End,
  isArrow,
  nearestDot,
  pinnedPatch,
  snapPatches,
  SNAP_TOLERANCE_PX,
} from "../../lib/lineAnchors";
import { lineAnchorRule } from "../components/host";
import type { El } from "../reactor/reactor";

type Api = ExcalidrawImperativeAPI;

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Excalidraw's binding bypass: Cmd on macOS, Ctrl elsewhere. */
export const bypassKey = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
  IS_MAC ? e.metaKey : e.ctrlKey;

/** What the overlay draws dots for: the arrow being dragged (or drawn). */
export interface SnapDrag {
  arrowId: string | null;
}

type Listener = (drag: SnapDrag | null) => void;
const listeners = new Set<Listener>();
let current: SnapDrag | null = null;

export function subscribeSnapDrag(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

function publish(drag: SnapDrag | null) {
  current = drag;
  for (const fn of listeners) fn(drag);
}

/** The arrow end the user grabbed with the linear editor, if any. */
export function grabbedEnd(api: Pick<Api, "getAppState">, elements: readonly El[]) {
  const state = api.getAppState();
  const editor = state.selectedLinearElement ?? state.editingLinearElement;
  if (!editor) return null;
  const arrow = elements.find((e) => e.id === editor.elementId);
  if (!isArrow(arrow) || arrow.isDeleted) return null;
  const i = editor.pointerDownState?.lastClickedPoint ?? -1;
  const end: End | null = i === 0 ? "start" : i === arrow.points.length - 1 ? "end" : null;
  return end ? { arrow, end } : null;
}

/**
 * Snap, bind and pin `ends` of `arrow` in place (or unpin the ones that missed). `zoom` turns
 * the screen-space tolerance into scene units. Returns whether anything was written.
 */
export function settleEnds(
  arrow: El,
  ends: readonly End[],
  elements: readonly El[],
  zoom: number,
  bypass: boolean,
): boolean {
  if (!isArrow(arrow) || arrow.points.length < 2) return false;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const get = (id: string) => {
    const el = byId.get(id);
    return el && !el.isDeleted ? el : undefined;
  };
  const shapes = elements.filter((e) => e.id !== arrow.id && !e.isDeleted);
  let wrote = false;
  for (const end of ends) {
    const pts = absolutePoints(arrow);
    const point = pts[end === "start" ? 0 : pts.length - 1];
    const bound = (end === "start" ? arrow.startBinding : arrow.endBinding)?.elementId;
    const hit = bypass ? null : nearestDot(shapes, point, SNAP_TOLERANCE_PX / zoom, bound);
    const patches = snapPatches(arrow, end, hit && { shape: hit.shape, anchor: hit.anchor }, get);
    for (const [id, patch] of patches) {
      const el = byId.get(id);
      if (!el) continue;
      if (id === arrow.id && isElbowArrow(arrow)) {
        // Set the binding, then re-route around it (Excalidraw routes on a binding write).
        const key = end === "start" ? "startBinding" : "endBinding";
        mutateElement(arrow, { [key]: patch[key] } as never, false);
        mutateElement(arrow, {
          startBinding: arrow.startBinding ? { ...arrow.startBinding } : null,
          endBinding: arrow.endBinding ? { ...arrow.endBinding } : null,
        } as never);
      } else {
        mutateElement(el, patch as never);
      }
      wrote = true;
    }
  }
  if (!isElbowArrow(arrow)) {
    // The other end may be pinned too and was suspended during the drag: put it back now.
    const rest = pinnedPatch(arrow, get);
    if (rest) {
      mutateElement(arrow, rest as never);
      wrote = true;
    }
  }
  return wrote;
}

export interface LineAnchorOptions {
  /** Snap on/off (the settings toggle); read at each gesture. */
  enabled?: () => boolean;
}

/** Wire snapping into an editor. Returns a disposer. */
export function installLineAnchors(api: Api, opts: LineAnchorOptions = {}): () => void {
  let drag: { arrowId: string | null; end: End | null; creating: boolean } | null = null;

  const offDown = api.onPointerDown((activeTool, _state, event) => {
    drag = null;
    if (opts.enabled && !opts.enabled()) return;
    const elements = api.getSceneElementsIncludingDeleted();
    const grabbed = grabbedEnd(api, elements);
    if (grabbed) {
      const { arrow } = grabbed;
      // History can't undo customData going from undefined to set, so give it a baseline.
      if (!arrow.customData && !isElbowArrow(arrow)) {
        api.updateScene({
          elements: elements.map((e) => (e.id === arrow.id ? { ...e, customData: {} } : e)),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      drag = { arrowId: arrow.id, end: grabbed.end, creating: false };
      lineAnchorRule(api)?.suspend([arrow.id]);
    } else if (activeTool.type === "arrow" && event.button === 0) {
      drag = { arrowId: null, end: null, creating: true };
    }
    if (drag) publish({ arrowId: drag.arrowId });
  });

  const offUp = api.onPointerUp((_tool, pointerDownState, event) => {
    const d = drag;
    drag = null;
    publish(null);
    const rule = lineAnchorRule(api);
    try {
      if (!d || !pointerDownState.drag.hasOccurred) return;
      const state = api.getAppState();
      const bypass = bypassKey(event) || state.isBindingEnabled === false;
      const elements = api.getSceneElementsIncludingDeleted();
      if (d.creating) {
        const arrow = state.newElement;
        if (!isArrow(arrow as El) || state.multiElement) return;
        const live = elements.find((e) => e.id === arrow!.id);
        if (live) settleEnds(live, ["start", "end"], elements, state.zoom.value, bypass);
        return;
      }
      const arrow = elements.find((e) => e.id === d.arrowId);
      if (arrow && d.end) settleEnds(arrow, [d.end], elements, state.zoom.value, bypass);
    } finally {
      rule?.resume();
    }
  });

  return () => {
    offDown();
    offUp();
    lineAnchorRule(api)?.resume();
    publish(null);
  };
}
