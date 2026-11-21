/** Scene writes and reads for the Data section; one `updateScene` = one undo step. */
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import { customDataWith, labelOf, readData, toCsv, type DataEntry } from "../../lib/shapeData";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { PanelApi } from "../propertiesPanel/panel";

/**
 * Rewrites the data of `ids` through `fn` as one undo step. Returns how many elements changed.
 * Throws (before writing anything) if any target's data is read-only or invalid.
 */
export function updateShapeData(
  api: Pick<PanelApi, "getSceneElementsIncludingDeleted" | "updateScene">,
  ids: readonly string[],
  fn: (entries: DataEntry[]) => DataEntry[],
): number {
  const want = new Set(ids);
  const scene = api.getSceneElementsIncludingDeleted();
  const next = new Map<string, NonNullable<ExcalidrawElement["customData"]>>();
  for (const el of scene) {
    if (!want.has(el.id) || el.isDeleted) continue;
    const customData = customDataWith(el, fn(readData(el).entries));
    if (customData !== el.customData) next.set(el.id, customData ?? {});
  }
  if (!next.size) return 0;
  // Undo applies deltas via newElementWith, which skips `undefined`: seed `{}` first (no history)
  // so undoing a first write actually clears it (same as commitUndoable in agent/scene/turns.ts).
  const unseeded = scene.filter((el) => next.has(el.id) && el.customData === undefined);
  let base = scene;
  if (unseeded.length) {
    const seedIds = new Set(unseeded.map((el) => el.id));
    api.updateScene({
      elements: scene.map((el) =>
        seedIds.has(el.id) ? newElementWith(el, { customData: {} } as never) : el,
      ),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    base = api.getSceneElementsIncludingDeleted();
  }
  const elements = base.map((el) => {
    const customData = next.get(el.id);
    return customData ? newElementWith(el, { customData }) : el;
  });
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return next.size;
}

export function shapeDataCsv(api: Pick<PanelApi, "getSceneElements">, ids: readonly string[]) {
  const all = api.getSceneElements();
  const byId = new Map(all.map((e) => [e.id, e]));
  const want = new Set(ids);
  return toCsv(
    all
      .filter((e) => want.has(e.id))
      .map((e) => ({ id: e.id, type: e.type, label: labelOf(e, byId), data: readData(e).entries })),
  );
}
