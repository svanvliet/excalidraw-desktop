/**
 * Pure view logic for the named-styles UI (docs/styles.md): the properties-panel "Style" row.
 */
import type { El } from "../../agent/scene/draft";
import {
  elementStyleInfo,
  isInstanceChild,
  listStyles,
  stylable,
  STYLE_KEYS,
  type StyleKey,
} from "../../extensions/styles/model";

export interface StyleSectionView {
  styles: Array<{ id: string; name: string }>;
  /** Selected elements that can be linked (instance children and labels of selected shapes excluded). */
  ids: string[];
  /** The style every target links to, null when none does, "mixed" otherwise. */
  current: string | null | "mixed";
  /** Overridden keys across the targets. */
  overrides: StyleKey[];
  /** Targets that have overrides. */
  overrideIds: string[];
  /** Only instance children are selected: the master's style name (or null if unstyled). */
  master?: { name: string | null };
}

/** The properties-panel view for a selection; null hides the section. */
export function styleSectionView(
  selected: readonly El[],
  all: readonly El[],
): StyleSectionView | null {
  const byId = new Map(all.map((e) => [e.id, e]));
  const get = (id: string) => byId.get(id);
  const picked = new Set(selected.map((e) => e.id));
  const targets = selected.filter(
    (e) =>
      stylable(e) &&
      !isInstanceChild(e) &&
      !(e.type === "text" && e.containerId && picked.has(e.containerId)),
  );
  if (!targets.length) {
    const children = selected.filter(isInstanceChild);
    if (!children.length) return null;
    return {
      styles: [],
      ids: [],
      current: null,
      overrides: [],
      overrideIds: [],
      master: { name: elementStyleInfo(children[0], get)?.name ?? null },
    };
  }
  const infos = targets.map((e) => elementStyleInfo(e, get));
  const first = infos[0]?.styleId ?? null;
  const current = infos.every((i) => (i?.styleId ?? null) === first) ? first : "mixed";
  const overrides = new Set<StyleKey>();
  const overrideIds: string[] = [];
  infos.forEach((i, n) => {
    if (!i?.overrides?.length) return;
    overrideIds.push(targets[n].id);
    for (const k of i.overrides) overrides.add(k);
  });
  return {
    styles: listStyles(all).map((s) => ({ id: s.id, name: s.name })),
    ids: targets.map((e) => e.id),
    current,
    overrides: STYLE_KEYS.filter((k) => overrides.has(k)),
    overrideIds,
  };
}

export const PROP_LABELS: Record<StyleKey, string> = {
  strokeColor: "Stroke",
  backgroundColor: "Background",
  fillStyle: "Fill",
  strokeWidth: "Stroke width",
  strokeStyle: "Stroke style",
  roughness: "Sloppiness",
  opacity: "Opacity",
  roundness: "Edges",
  fontFamily: "Font",
  fontSize: "Font size",
  textColor: "Text colour",
};
