/** Scene writes and reads for the Data section; one `updateScene` = one undo step. */
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import { customDataWith, labelOf, readData, toCsv, type DataEntry } from "../../lib/shapeData";
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
  let changed = 0;
  const elements = api.getSceneElementsIncludingDeleted().map((el) => {
    if (!want.has(el.id) || el.isDeleted) return el;
    const customData = customDataWith(el, fn(readData(el).entries));
    if (customData === el.customData) return el;
    changed++;
    return newElementWith(el, { customData });
  });
  if (changed) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return changed;
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
