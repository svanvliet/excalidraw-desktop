/**
 * "Data" properties-panel section (docs/plan.md D-DX2): key/value rows on the selection. A mixed
 * selection shows the keys every element shares; edits apply to all of them.
 *
 * Progressive disclosure (FR-65, D-DX19): the row shows only when the selection has data;
 * otherwise "Add data" in the strip's "+" menu reveals it.
 */
import { dataTargets, sharedData, type SharedData } from "../../lib/shapeData";
import { DataIcon } from "../icons";
import type { PanelSection } from "../propertiesPanel/panel";
import { DataSection } from "./DataSection";

export interface DataView extends SharedData {
  ids: string[];
}

export const dataPanelSection: PanelSection<DataView> = {
  id: "data",
  slot: "top",
  testId: "shape-data",
  title: "Data",
  icon: DataIcon,
  summary: ({ rows, partial }) => {
    const keys = rows.map((r) => r.key).join(", ");
    if (!keys) return partial ? `${partial} partial` : "None";
    return partial ? `${keys} · ${partial} partial` : keys;
  },
  inUse: ({ rows, partial, readOnly }) => rows.length > 0 || partial > 0 || readOnly,
  more: () => ({ label: "Add data", title: "Add key/value data to the selection" }),
  view({ selected }) {
    const targets = dataTargets(selected);
    if (!targets.length) return null;
    return { ids: targets.map((e) => e.id), ...sharedData(targets) };
  },
  Component: DataSection,
};
