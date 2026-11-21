/**
 * Named styles sync (FR-58, D-DX12): makes every element linked to one style look like the
 * style plus its own overrides. Used by the reactor rule (live) and by the draft actions (so a
 * command's single undo step is already consistent). Pure over a small access interface.
 *
 * Per style:
 *  1. The winning definition is the one with the highest `rev` among live members.
 *  2. A member the user changed adopts its direct edits to style keys as overrides. A key counts
 *     as edited when its value differs both from what the member's own tag says it should be
 *     and (when known) from the value last seen. A value equal to the style drops the override.
 *  3. Every member gets the winning definition, overrides cleaned to keys the style sets and
 *     that apply to it, and the element values that result. Font changes re-measure text.
 */
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { El, Patch } from "../reactor/reactor";
import { layoutBoundText, measureFreeText } from "../components/text";
import {
  appliedKeys,
  elementPatchFor,
  isStyleMember,
  sameDef,
  STYLE_KEYS,
  styleTagOf,
  valueOf,
  winnerDef,
  withStyleTag,
  type StyleDef,
  type StyleKey,
  type StyleProps,
  type StyleTag,
} from "./model";

type TextEl = ExcalidrawTextElement;

export interface StyleAccess {
  /** Any element (deleted included), with this sync's own writes applied. */
  get(id: string): El | undefined;
  /** Elements linked to the style (deleted included). */
  members(styleId: string): El[];
  patch(id: string, patch: Patch): void;
}

export interface StyleSyncOptions {
  /** Elements the user changed directly since the last sync. */
  changed?: ReadonlySet<string>;
  /** Style values last seen per element (the rule keeps this; drafts use their originals). */
  memory?: Map<string, StyleProps>;
}

const EMPTY = new Set<string>();

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

const isBound = (el: El) => el.type === "text" && !!(el as TextEl).containerId;

/** What `tag` says `el` should show for `key` (undefined when the style doesn't set it). */
function expected(el: El, props: StyleProps, ov: StyleProps | undefined, key: StyleKey) {
  if (!appliedKeys(el, props).includes(key)) return undefined;
  return ov && key in ov ? ov[key] : props[key];
}

/** Current style values of every key that applies to `el`. */
export function styleValues(el: El): StyleProps {
  const out: StyleProps = {};
  for (const k of STYLE_KEYS) out[k] = valueOf(el, k);
  return out;
}

/** Overrides kept: keys the winner sets on `el` whose value differs from it. */
function cleanStyleOverrides(el: El, def: StyleDef, ov: StyleProps): StyleProps | undefined {
  const out: StyleProps = {};
  for (const k of appliedKeys(el, def.props)) {
    if (k in ov && !same(ov[k], def.props[k])) out[k] = ov[k];
  }
  return Object.keys(out).length ? out : undefined;
}

export function tagFor(def: StyleDef, overrides?: StyleProps): StyleTag {
  const tag: StyleTag = { v: 1, id: def.id, name: def.name, rev: def.rev, props: def.props };
  if (overrides && Object.keys(overrides).length) tag.overrides = overrides;
  return tag;
}

/** Element patch that applies `tag` to `el` (style keys only, no relayout). */
export function lookPatch(el: El, tag: StyleTag): Patch {
  const p: Patch = {};
  for (const k of appliedKeys(el, tag.props)) {
    const want = tag.overrides && k in tag.overrides ? tag.overrides[k] : tag.props[k];
    if (!same(valueOf(el, k), want)) Object.assign(p, elementPatchFor(el, k, want));
  }
  return p;
}

/** Re-measure a text element after a font change (bound text may grow its container). */
export function relayoutText(id: string, access: Pick<StyleAccess, "get" | "patch">): void {
  const t = access.get(id) as TextEl | undefined;
  if (!t || t.type !== "text" || t.isDeleted) return;
  if (t.containerId) {
    const container = access.get(t.containerId);
    if (!container || container.isDeleted) return;
    const laid = layoutBoundText(container, t, t.originalText);
    if (!laid) return;
    if (laid.containerHeight > container.height + 0.01) {
      access.patch(container.id, { height: laid.containerHeight });
      const again = layoutBoundText(access.get(container.id)!, t, t.originalText);
      access.patch(id, (again ?? laid).text);
    } else access.patch(id, laid.text);
    return;
  }
  if (t.autoResize === false) return;
  const m = measureFreeText(t, t.originalText);
  const x =
    t.textAlign === "center"
      ? t.x + t.width / 2 - m.width / 2
      : t.textAlign === "right"
        ? t.x + t.width - m.width
        : t.x;
  access.patch(id, { x, width: m.width, height: m.height, text: m.text });
}

const FONT_PROPS = ["fontFamily", "fontSize", "lineHeight"];

/** Bring every member of `styleId` in line with the winning definition. */
export function syncStyle(styleId: string, access: StyleAccess, opts: StyleSyncOptions = {}): void {
  const changed = opts.changed ?? EMPTY;
  const members = access
    .members(styleId)
    .filter((el) => isStyleMember(el) && styleTagOf(el)!.id === styleId)
    // Containers before their bound text, so text is measured in the final container.
    .sort((a, b) => Number(isBound(a)) - Number(isBound(b)) || (a.id < b.id ? -1 : 1));
  if (!members.length) return;
  const def = winnerDef(members.map((m) => styleTagOf(m)!))!;

  for (const m of members) {
    const el = access.get(m.id) ?? m;
    const own = styleTagOf(el)!;
    let ov: StyleProps = { ...(own.overrides ?? {}) };
    if (changed.has(el.id)) {
      const seen = opts.memory?.get(el.id);
      for (const k of STYLE_KEYS) {
        const exp = expected(el, own.props, own.overrides, k);
        if (exp === undefined) continue;
        const v = valueOf(el, k);
        if (same(v, exp) || (seen && same(v, seen[k]))) continue;
        ov[k] = v;
      }
    }
    ov = cleanStyleOverrides(el, def, ov) ?? {};
    const tag = tagFor(def, ov);
    const p = lookPatch(el, tag);
    const tagChanged = !sameDef(own, def) || !same(own.overrides ?? {}, tag.overrides ?? {});
    if (tagChanged) p.customData = withStyleTag(el, tag);
    if (Object.keys(p).length) access.patch(el.id, p);
    if (el.type === "text" && FONT_PROPS.some((k) => k in p)) relayoutText(el.id, access);
  }

  if (opts.memory)
    for (const m of members) opts.memory.set(m.id, styleValues(access.get(m.id) ?? m));
}
