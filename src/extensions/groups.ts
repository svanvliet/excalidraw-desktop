import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { listExtensions } from "./registry";

export interface ExtensionGroup {
  id: string;
  title: string;
  description?: string;
  ids: string[];
  presets: { id: string; label: string; params: Record<string, unknown>; active: boolean }[];
  /** At least one target has this extension applied. */
  removable: boolean;
}

const sameParams = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

/** Extensions applicable to the selection and their preset / remove state. */
export function extensionGroups(selected: readonly ExcalidrawElement[]): ExtensionGroup[] {
  const groups: ExtensionGroup[] = [];
  for (const ext of listExtensions()) {
    const targets = selected.filter((el) => ext.appliesTo(el));
    if (!targets.length) continue;
    const intents = targets.map((el) => ext.getIntent(el));
    groups.push({
      id: ext.id,
      title: ext.title,
      description: ext.description,
      ids: targets.map((el) => el.id),
      presets: ext.presets.map((p) => ({
        id: p.id,
        label: p.label,
        params: p.params,
        // Active only when every target carries exactly this preset.
        active: intents.every((i) => i !== null && sameParams(i.params, p.params)),
      })),
      removable: intents.some((i) => i !== null),
    });
  }
  return groups;
}
