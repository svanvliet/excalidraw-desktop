/**
 * Named styles data model (FR-58, D-DX12, docs/styles.md).
 *
 * Every element linked to a style carries the whole definition in
 * `customData["excalidrawDesktop.style"]` (denormalised): `{ v, id, name, rev, props, overrides? }`.
 * A style exists while at least one live element uses it. When copies disagree (paste of an old
 * copy, concurrent collab edits) the definition with the highest `rev` wins, ties broken by a
 * stable comparison, so every peer picks the same one.
 *
 * Component instance children are never members: they take their look from the master (whose
 * children can be styled) through the components rule. A style tag they carry is inert.
 */
import { convertToExcalidrawElements, FONT_FAMILY, ROUNDNESS } from "@excalidraw/excalidraw";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import { tagOf as componentTagOf } from "../components/model";
import type { El, Patch } from "../reactor/reactor";

export const STYLE_NS = "excalidrawDesktop.style";
export const STYLE_MODEL_VERSION = 1;

export const STYLE_KEYS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "fontFamily",
  "fontSize",
  "textColor",
] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];
export type StyleProps = Partial<Record<StyleKey, unknown>>;

export interface StyleTag {
  v: 1;
  id: string;
  name: string;
  rev: number;
  props: StyleProps;
  overrides?: StyleProps;
}

export interface StyleDef {
  id: string;
  name: string;
  rev: number;
  props: StyleProps;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The element's style tag, or null if none (or one this version can't read). */
export function styleTagOf(el: El | undefined | null): StyleTag | null {
  const raw = el?.customData?.[STYLE_NS];
  if (!isRecord(raw) || raw.v !== STYLE_MODEL_VERSION) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  if (typeof raw.rev !== "number" || !isRecord(raw.props)) return null;
  if (raw.overrides !== undefined && !isRecord(raw.overrides)) return null;
  return raw as unknown as StyleTag;
}

/** True when the element has a style tag of any version (so we must leave it alone). */
export function hasAnyStyleTag(el: El): boolean {
  return el.customData?.[STYLE_NS] !== undefined;
}

/** `customData` with the style tag replaced (or removed when `tag` is null). */
export function withStyleTag(el: El, tag: StyleTag | null): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(el.customData ?? {}) };
  if (tag) next[STYLE_NS] = tag;
  else delete next[STYLE_NS];
  return next;
}

export const isInstanceChild = (el: El) => componentTagOf(el)?.role === "instance";

/** A live element whose style tag counts (instance children follow their master instead). */
export function isStyleMember(el: El | undefined): el is El {
  return !!el && !el.isDeleted && !!styleTagOf(el) && !isInstanceChild(el);
}

// --- which keys apply to which element -----------------------------------------------------

const TEXT_KEYS: ReadonlySet<StyleKey> = new Set([
  "fontFamily",
  "fontSize",
  "textColor",
  "opacity",
]);
const SHAPE_KEYS: ReadonlySet<StyleKey> = new Set([
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
]);
const ADAPTIVE = new Set(["rectangle", "image", "embeddable", "iframe"]);
const PROPORTIONAL = new Set(["diamond", "line", "arrow"]);

function supportsRoundness(el: El): boolean {
  if (el.type === "arrow" && (el as { elbowed?: boolean }).elbowed) return false;
  return ADAPTIVE.has(el.type) || PROPORTIONAL.has(el.type);
}

/** Whether a style key affects this element. */
export function applies(el: El, key: StyleKey): boolean {
  if (el.type === "text") return TEXT_KEYS.has(key);
  if (el.type === "frame" || el.type === "magicframe") return false;
  if (el.type === "image") return key === "opacity" || key === "roundness";
  if (key === "roundness") return supportsRoundness(el);
  return SHAPE_KEYS.has(key);
}

export function stylable(el: El): boolean {
  return STYLE_KEYS.some((k) => applies(el, k));
}

const rec = (el: El) => el as unknown as Record<string, unknown>;

/** The element's current value for a style key (in style terms). */
export function valueOf(el: El, key: StyleKey): unknown {
  if (key === "textColor") return el.strokeColor;
  if (key === "roundness") return el.roundness ? "round" : "sharp";
  return rec(el)[key];
}

const lineHeights = new Map<number, number>();
/** Excalidraw's line height for a font family (its `getLineHeight` isn't exported). */
export function lineHeightOf(fontFamily: number): number {
  let lh = lineHeights.get(fontFamily);
  if (lh === undefined) {
    const [t] = convertToExcalidrawElements(
      [{ type: "text", id: "__style_lh__", x: 0, y: 0, text: "x", fontFamily }] as never,
      { regenerateIds: false },
    ) as ExcalidrawTextElement[];
    lh = t.lineHeight;
    lineHeights.set(fontFamily, lh);
  }
  return lh;
}

/** Element props that give `el` the style value `value` for `key`. */
export function elementPatchFor(el: El, key: StyleKey, value: unknown): Patch {
  switch (key) {
    case "textColor":
      return { strokeColor: value };
    case "roundness":
      if (value !== "round") return { roundness: null };
      if (el.roundness) return { roundness: el.roundness };
      return {
        roundness: {
          type: ADAPTIVE.has(el.type) ? ROUNDNESS.ADAPTIVE_RADIUS : ROUNDNESS.PROPORTIONAL_RADIUS,
        },
      };
    case "fontFamily":
      return { fontFamily: value, lineHeight: lineHeightOf(value as number) };
    default:
      return { [key]: value };
  }
}

// --- validation -----------------------------------------------------------------------------

const FILL = ["hachure", "cross-hatch", "solid", "zigzag"];
const STROKE = ["solid", "dashed", "dotted"];
const FONT_IDS = new Set<number>(Object.values(FONT_FAMILY) as number[]);

export class StyleError extends Error {}

/** Normalise one style value; throws a {@link StyleError} for invalid input. */
export function normaliseValue(key: StyleKey, v: unknown): unknown {
  const fail = (msg: string): never => {
    throw new StyleError(`${key} ${msg}`);
  };
  switch (key) {
    case "strokeColor":
    case "backgroundColor":
    case "textColor":
      if (typeof v !== "string" || !v.trim()) fail("must be a colour string");
      return (v as string).trim();
    case "fillStyle":
      if (!FILL.includes(v as string)) fail(`must be one of ${FILL.join(", ")}`);
      return v;
    case "strokeStyle":
      if (!STROKE.includes(v as string)) fail(`must be one of ${STROKE.join(", ")}`);
      return v;
    case "strokeWidth":
    case "fontSize":
      if (typeof v !== "number" || !(v > 0) || v > 1000) fail("must be a positive number");
      return v;
    case "roughness":
      if (typeof v !== "number" || v < 0 || v > 2) fail("must be 0, 1 or 2");
      return Math.round(v as number);
    case "opacity":
      if (typeof v !== "number" || v < 0 || v > 100) fail("must be between 0 and 100");
      return v;
    case "roundness":
      if (v !== "round" && v !== "sharp") fail('must be "round" or "sharp"');
      return v;
    case "fontFamily": {
      if (typeof v === "string" && v in FONT_FAMILY)
        return (FONT_FAMILY as Record<string, number>)[v];
      if (typeof v !== "number" || !FONT_IDS.has(v))
        fail(`must be a font id or one of ${Object.keys(FONT_FAMILY).join(", ")}`);
      return v;
    }
  }
}

/** Validated props. `null` values are kept when allowed (they mean "unset" in an update). */
export function normaliseProps(raw: unknown, allowNull = false): Record<string, unknown> {
  if (!isRecord(raw)) throw new StyleError("props must be an object");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(STYLE_KEYS as readonly string[]).includes(k))
      throw new StyleError(`Unknown style property "${k}" (use ${STYLE_KEYS.join(", ")})`);
    if (v === null && allowNull) out[k] = null;
    else out[k] = normaliseValue(k as StyleKey, v);
  }
  return out;
}

// --- definitions ----------------------------------------------------------------------------

export const defOf = (t: StyleTag): StyleDef => ({
  id: t.id,
  name: t.name,
  rev: t.rev,
  props: t.props,
});

const defKey = (d: StyleDef) => JSON.stringify([d.name, d.props]);

/** The definition every peer agrees on: highest `rev`, then a stable comparison. */
export function winnerDef(tags: readonly StyleTag[]): StyleDef | null {
  let best: StyleDef | null = null;
  for (const t of tags) {
    const d = defOf(t);
    if (!best || d.rev > best.rev || (d.rev === best.rev && defKey(d) > defKey(best))) best = d;
  }
  return best;
}

export function sameDef(t: StyleTag, d: StyleDef): boolean {
  return t.rev === d.rev && defKey(defOf(t)) === defKey(d);
}

/** Keys this style sets on `el`. */
export function appliedKeys(el: El, props: StyleProps): StyleKey[] {
  return STYLE_KEYS.filter((k) => props[k] !== undefined && props[k] !== null && applies(el, k));
}

export interface StyleInfo extends StyleDef {
  /** Live linked elements (component instance children excluded). */
  elementIds: string[];
}

/** Every style used on the canvas, sorted by name. */
export function listStyles(elements: readonly El[]): StyleInfo[] {
  const byId = new Map<string, { tags: StyleTag[]; ids: string[] }>();
  for (const el of elements) {
    if (!isStyleMember(el)) continue;
    const t = styleTagOf(el)!;
    let entry = byId.get(t.id);
    if (!entry) byId.set(t.id, (entry = { tags: [], ids: [] }));
    entry.tags.push(t);
    entry.ids.push(el.id);
  }
  const out: StyleInfo[] = [];
  for (const { tags, ids } of byId.values()) out.push({ ...winnerDef(tags)!, elementIds: ids });
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

export interface ElementStyleInfo {
  styleId: string;
  name: string;
  /** Keys this element overrides locally. */
  overrides?: StyleKey[];
  /** True for component instance children: the style comes from the master, read-only here. */
  fromMaster?: boolean;
}

export function elementStyleInfo(el: El): ElementStyleInfo | null {
  const t = styleTagOf(el);
  if (!t) return null;
  const info: ElementStyleInfo = { styleId: t.id, name: t.name };
  if (isInstanceChild(el)) info.fromMaster = true;
  else if (t.overrides && Object.keys(t.overrides).length)
    info.overrides = Object.keys(t.overrides) as StyleKey[];
  return info;
}

/** Style props read from a selection: shape keys from the first shape, text keys from the first text. */
export function propsFromElements(elements: readonly El[]): StyleProps {
  const props: StyleProps = {};
  const shape = elements.find((e) => e.type !== "text" && e.type !== "image" && stylable(e));
  const text = elements.find((e) => e.type === "text");
  const image = elements.find((e) => e.type === "image");
  for (const src of [shape, text, image]) {
    if (!src) continue;
    for (const k of STYLE_KEYS) if (!(k in props) && applies(src, k)) props[k] = valueOf(src, k);
  }
  return props;
}
