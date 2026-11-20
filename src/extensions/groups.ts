import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { listExtensions } from "./registry";
import { linkOf } from "./stack";

type Params = Record<string, unknown>;

export interface ExtensionGroup {
  id: string;
  title: string;
  description?: string;
  ids: string[];
  presets: { id: string; label: string; params: Params; active: boolean }[];
  /** Quick picks for one param (e.g. border colour); `active` when every target uses it. */
  choices?: {
    param: string;
    label: string;
    options: { value: string | number; label: string; swatch?: string; active: boolean }[];
  };
  /** At least one target has this extension applied. */
  removable: boolean;
  /** Params shared by every target when all have this extension applied identically. */
  current: Params | null;
  /** Params a choice applies on top of when nothing shared is applied (the default preset). */
  base: Params;
}

const stableJson = (p: Params) => JSON.stringify(p, Object.keys(p).sort());
const isSubset = (sub: Params, of: Params) =>
  Object.entries(sub).every(([k, v]) => of[k] === v);

/** Extensions applicable to the selection and their preset / choice / remove state. */
export function extensionGroups(selected: readonly ExcalidrawElement[]): ExtensionGroup[] {
  const groups: ExtensionGroup[] = [];
  for (const ext of listExtensions()) {
    const targets = selected.filter((el) => ext.appliesTo(el));
    if (!targets.length) continue;
    const links = targets.map((el) => linkOf(el, ext.id));
    const all = links.every((l) => l !== null);
    const params = links.flatMap((l) => (l ? [l.params] : []));
    const current =
      all && params.every((p) => stableJson(p) === stableJson(params[0])) ? params[0] : null;
    // Every target has it applied and its params include all the given ones.
    const activeFor = (p: Params) => all && params.every((lp) => isSubset(p, lp));
    const base = (ext.presets.find((p) => p.id === ext.defaultPreset) ?? ext.presets[0])
      ?.params as Params | undefined;
    groups.push({
      id: ext.id,
      title: ext.title,
      description: ext.description,
      ids: targets.map((el) => el.id),
      presets: ext.presets.map((p) => ({
        id: p.id,
        label: p.label,
        params: p.params as Params,
        active: activeFor(p.params as Params),
      })),
      choices: ext.choices && {
        param: ext.choices.param,
        label: ext.choices.label,
        options: ext.choices.options.map((o) => ({
          ...o,
          active: activeFor({ [ext.choices!.param]: o.value }),
        })),
      },
      removable: links.some((l) => l !== null),
      current,
      base: { ...(base ?? {}) },
    });
  }
  return groups;
}

/** Params for a preset click: the preset, keeping the shared value of the choice param. */
export function presetParams(group: ExtensionGroup, presetId: string): Params {
  const preset = group.presets.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown preset ${presetId}`);
  const out = { ...preset.params };
  const param = group.choices?.param;
  if (param && !(param in out) && group.current && param in group.current) {
    out[param] = group.current[param];
  }
  return out;
}

/** Params for a choice click: the shared current params (or the default preset) with `value`. */
export function choiceParams(group: ExtensionGroup, value: string | number): Params {
  if (!group.choices) throw new Error(`${group.id} has no choices`);
  return { ...(group.current ?? group.base), [group.choices.param]: value };
}
