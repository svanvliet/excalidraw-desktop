/**
 * Placing components from the UI (FR-55): in-document instances and saved ("My components")
 * entries, at the viewport centre (click) or at a drop point (drag from the Components tab).
 * Each placement is one undo step (`runComponentCommand`), and selects the new instance.
 */
import { CaptureUpdateAction, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { DragEvent } from "react";
import type { El } from "../../agent/scene/draft";
import { insertInstance } from "../../extensions/components/actions";
import { runComponentCommand } from "../../extensions/components/host";
import { listComponents } from "../../extensions/components/model";
import { getMyComponents, type MyComponent } from "../../lib/componentLibraryStore";
import { insertMyComponent } from "./libraryCodec";

type Api = ExcalidrawImperativeAPI;

/** Drag payload MIME type: `{ source: "doc" | "mine", id }`. */
export const COMPONENT_DRAG_MIME = "application/x-excalidraw-desktop-component";

export interface ComponentDragPayload {
  source: "doc" | "mine";
  id: string;
}

/** Width / height of a set of elements (linear elements by their points). */
export function sizeOf(els: readonly El[]): { w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const el of els) {
    const pts = (el as { points?: readonly (readonly [number, number])[] }).points;
    if (pts?.length) {
      for (const [px, py] of pts) {
        x0 = Math.min(x0, el.x + px);
        y0 = Math.min(y0, el.y + py);
        x1 = Math.max(x1, el.x + px);
        y1 = Math.max(y1, el.y + py);
      }
    } else {
      x0 = Math.min(x0, el.x);
      y0 = Math.min(y0, el.y);
      x1 = Math.max(x1, el.x + el.width);
      y1 = Math.max(y1, el.y + el.height);
    }
  }
  return Number.isFinite(x0) ? { w: x1 - x0, h: y1 - y0 } : { w: 0, h: 0 };
}

/** Scene point at the centre of the editor's viewport. */
export function viewportCenter(api: Api): { x: number; y: number } {
  const s = api.getAppState();
  return viewportCoordsToSceneCoords(
    { clientX: s.offsetLeft + s.width / 2, clientY: s.offsetTop + s.height / 2 },
    s,
  );
}

function selectGroup(api: Api, groupId: string, ids: readonly string[]) {
  api.updateScene({
    appState: {
      selectedGroupIds: { [groupId]: true },
      selectedElementIds: Object.fromEntries(ids.map((id) => [id, true as const])),
      editingGroupId: null,
    } as never,
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

function masterEls(api: Api, componentId: string): El[] {
  const els = api.getSceneElements() as readonly El[];
  const info = listComponents(els).find((c) => c.componentId === componentId);
  const ids = new Set(info?.masterIds ?? []);
  return els.filter((e) => ids.has(e.id));
}

/** An instance of an in-document component, centred on `center` (default: viewport centre). */
export function placeInstance(api: Api, componentId: string, center = viewportCenter(api)) {
  const { w, h } = sizeOf(masterEls(api, componentId));
  const res = runComponentCommand(api, (d) =>
    insertInstance(d, componentId, { x: center.x - w / 2, y: center.y - h / 2 }),
  );
  if (res) selectGroup(api, res.groupId, res.ids);
  return res;
}

/**
 * A saved component, centred on `center`: an instance when the document has its master, else
 * the master there plus an instance beside it (both in one undo step).
 */
export function placeMyComponent(api: Api, entry: MyComponent, center = viewportCenter(api)) {
  if (api.getAppState().viewModeEnabled) return null;
  const { w, h } = sizeOf(entry.elements);
  const files = Object.values(entry.files ?? {});
  // Images first, so the new elements render straight away; files aren't part of undo.
  if (files.length) api.addFiles(files);
  const res = runComponentCommand(api, (d) =>
    insertMyComponent(d, entry, { x: center.x - w / 2, y: center.y - h / 2 }),
  );
  if (res) {
    selectGroup(api, res.instance.groupId, res.instance.ids);
    if (res.placedMaster)
      api.setToast({ message: `Added "${entry.name}" and its master to this drawing`, duration: 2500 });
  }
  return res;
}

export function setDragPayload(e: DragEvent, payload: ComponentDragPayload) {
  e.dataTransfer.setData(COMPONENT_DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "copy";
}

const hasPayload = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(COMPONENT_DRAG_MIME);

/** Capture-phase dragover on the editor wrapper: accept component drags. */
export function handleComponentDragOver(api: Api | null, e: DragEvent) {
  if (!api || !hasPayload(e)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = api.getAppState().viewModeEnabled ? "none" : "copy";
}

/** Capture-phase drop on the editor wrapper: place the dragged component at the drop point. */
export function handleComponentDrop(api: Api | null, e: DragEvent): boolean {
  if (!api || !hasPayload(e)) return false;
  // Keep Excalidraw's own drop (files / library items) from also handling it.
  e.preventDefault();
  e.stopPropagation();
  let payload: ComponentDragPayload;
  try {
    payload = JSON.parse(e.dataTransfer.getData(COMPONENT_DRAG_MIME)) as ComponentDragPayload;
  } catch {
    return false;
  }
  const at = viewportCoordsToSceneCoords(
    { clientX: e.clientX, clientY: e.clientY },
    api.getAppState(),
  );
  if (payload.source === "doc") return !!placeInstance(api, payload.id, at);
  const entry = getMyComponents().find((c) => c.id === payload.id);
  return !!entry && !!placeMyComponent(api, entry, at);
}
