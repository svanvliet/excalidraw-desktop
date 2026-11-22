/**
 * "Data" properties-panel section (docs/plan.md D-DX2): key/value rows on the selection. A mixed
 * selection shows the keys every element shares; edits apply to all of them.
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
  view({ selected }) {
    const targets = dataTargets(selected);
    if (!targets.length) return null;
    return { ids: targets.map((e) => e.id), ...sharedData(targets) };
  },
  Component: DataSection,
};
