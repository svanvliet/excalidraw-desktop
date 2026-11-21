/**
 * Pure view logic for the named-styles UI (docs/styles.md): the properties-panel "Style" section
 * and the editor rows of the Styles sidebar tab.
 */
import { FONT_FAMILY } from "@excalidraw/excalidraw";
import type { El } from "../../agent/scene/draft";
import {
  elementStyleInfo,
  isInstanceChild,
  listStyles,
  normaliseValue,
  stylable,
  STYLE_KEYS,
  StyleError,
  type StyleKey,
  type StyleProps,
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

// --- editor rows -------------------------------------------------------------------------------

export type PropControl =
  | { kind: "color" }
  | { kind: "number"; min: number; max: number; step: number }
  | { kind: "select"; options: Array<{ value: string; label: string }> };

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

const opts = (pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));

export const PROP_CONTROLS: Record<StyleKey, PropControl> = {
  strokeColor: { kind: "color" },
  backgroundColor: { kind: "color" },
  textColor: { kind: "color" },
  fillStyle: {
    kind: "select",
    options: opts([
      ["hachure", "Hachure"],
      ["cross-hatch", "Cross-hatch"],
      ["solid", "Solid"],
      ["zigzag", "Zigzag"],
    ]),
  },
  strokeStyle: {
    kind: "select",
    options: opts([
      ["solid", "Solid"],
      ["dashed", "Dashed"],
      ["dotted", "Dotted"],
    ]),
  },
  roughness: {
    kind: "select",
    options: opts([
      ["0", "Architect"],
      ["1", "Artist"],
      ["2", "Cartoonist"],
    ]),
  },
  roundness: {
    kind: "select",
    options: opts([
      ["round", "Round"],
      ["sharp", "Sharp"],
    ]),
  },
  fontFamily: {
    kind: "select",
    // Read lazily: tests mock @excalidraw/excalidraw without FONT_FAMILY.
    get options() {
      return Object.entries(FONT_FAMILY).map(([label, id]) => ({ value: String(id), label }));
    },
  },
  strokeWidth: { kind: "number", min: 0.5, max: 100, step: 0.5 },
  fontSize: { kind: "number", min: 1, max: 1000, step: 1 },
  opacity: { kind: "number", min: 0, max: 100, step: 10 },
};

/** Value used when a property is added to a style in the editor. */
export const PROP_DEFAULTS: Record<StyleKey, unknown> = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundness: "round",
  get fontFamily() {
    return FONT_FAMILY.Excalifont;
  },
  fontSize: 20,
  textColor: "#1e1e1e",
};

/** How a style value shows in its control. */
export function formatProp(_key: StyleKey, value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Parse a control's raw value into a style value; throws a StyleError when invalid. */
export function parseProp(key: StyleKey, raw: string): unknown {
  const control = PROP_CONTROLS[key];
  const text = raw.trim();
  if (control.kind === "color") return normaliseValue(key, text);
  if (control.kind === "number" || key === "roughness" || key === "fontFamily") {
    const n = Number(text);
    if (!text || !Number.isFinite(n)) throw new StyleError(`${PROP_LABELS[key]} must be a number`);
    return normaliseValue(key, n);
  }
  return normaliseValue(key, text);
}

/** Keys the style doesn't set yet, in display order. */
export const missingProps = (props: StyleProps): StyleKey[] =>
  STYLE_KEYS.filter((k) => props[k] === undefined || props[k] === null);

/** Swatch colours for a style row. */
export function swatchOf(props: StyleProps): { stroke: string; fill: string } {
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  return {
    stroke: str(props.strokeColor ?? props.textColor, "#1e1e1e"),
    fill: str(props.backgroundColor, "transparent"),
  };
}
