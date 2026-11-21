/**
 * Named styles actions on a scene `Draft` (agent tools and UI share them). Each action leaves the
 * draft's styles fully synced, so committing it is one consistent undo step. Callers then run the
 * components `syncEdited` so styled master children reach their instances in the same step.
 */
import { Draft, newId, ToolError, type El } from "../../agent/scene/draft";
import { effectivePatch } from "../reactor/reactor";
import {
  isInstanceChild,
  listStyles,
  normaliseProps,
  propsFromElements,
  STYLE_KEYS,
  StyleError,
  styleTagOf,
  stylable,
  withStyleTag,
  type StyleDef,
  type StyleInfo,
  type StyleKey,
  type StyleProps,
  type StyleTag,
} from "./model";
import { styleValues, syncStyle, tagFor, type StyleAccess } from "./sync";

export function styleDraftAccess(draft: Draft): StyleAccess {
  return {
    get: (id) => draft.peek(id),
    members: (sid) => draft.toArray().filter((e) => styleTagOf(e)?.id === sid),
    patch: (id, p) => {
      const cur = draft.peek(id);
      const eff = cur && effectivePatch(cur, p);
      if (eff) draft.update(id, eff);
    },
  };
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof StyleError) throw new ToolError(err.message);
    throw err;
  }
}

export function stylesOf(draft: Draft): StyleInfo[] {
  return listStyles(draft.toArray());
}

/** A style by id, or by exact (case-insensitive) name when that is unambiguous. */
export function resolveStyle(draft: Draft, ref: unknown): StyleInfo {
  if (typeof ref !== "string" || !ref)
    throw new ToolError(`Expected a style id or name, got ${JSON.stringify(ref)}`);
  const all = stylesOf(draft);
  const byId = all.find((s) => s.id === ref);
  if (byId) return byId;
  const byName = all.filter((s) => s.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1)
    throw new ToolError(
      `Several styles are named "${ref}"; use the id (${byName.map((s) => s.id).join(", ")})`,
    );
  throw new ToolError(`No style "${ref}" on this canvas (list_styles shows the styles in use)`);
}

/** Elements a style action applies to: the ids plus bound text, minus component instance children. */
function targetsOf(draft: Draft, ids: unknown): El[] {
  if (!Array.isArray(ids) || !ids.length) throw new ToolError("Select at least one element");
  const out = new Map<string, El>();
  let instanceChildren = 0;
  for (const id of ids) {
    const el = draft.mustGet(id);
    for (const e of [el, draft.boundTextOf(el)]) {
      if (!e || out.has(e.id)) continue;
      if (isInstanceChild(e)) instanceChildren++;
      else if (stylable(e)) out.set(e.id, e);
    }
  }
  if (!out.size)
    throw new ToolError(
      instanceChildren
        ? "Component instances follow their master; style the master instead"
        : "None of these elements can take a style",
    );
  return [...out.values()];
}

function uniqueName(draft: Draft): string {
  const names = new Set(stylesOf(draft).map((s) => s.name));
  let n = names.size + 1;
  while (names.has(`Style ${n}`)) n++;
  return `Style ${n}`;
}

function cleanName(name: unknown): string | undefined {
  if (name === undefined || name === null) return undefined;
  if (typeof name !== "string" || !name.trim())
    throw new ToolError("name must be a non-empty string");
  return name.trim().slice(0, 80);
}

const definedProps = (p: StyleProps): StyleProps =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null));

export interface StyleResult {
  styleId: string;
  name: string;
  elementIds: string[];
}

export interface UnlinkResult {
  styleId: null;
  /** Elements that were unlinked. */
  elementIds: string[];
}

/** New style from `ids` (their look, or `props`), linked to them. */
export function createStyle(
  draft: Draft,
  ids: unknown,
  name?: unknown,
  props?: unknown,
): StyleResult {
  const targets = targetsOf(draft, ids);
  const p = definedProps(
    props === undefined ? propsFromElements(targets) : guard(() => normaliseProps(props)),
  );
  if (!Object.keys(p).length) throw new ToolError("A style needs at least one property");
  const def: StyleDef = {
    id: newId(),
    name: cleanName(name) ?? uniqueName(draft),
    rev: 1,
    props: p,
  };
  for (const el of targets) draft.update(el.id, { customData: withStyleTag(el, tagFor(def)) });
  syncStyle(def.id, styleDraftAccess(draft));
  return { styleId: def.id, name: def.name, elementIds: targets.map((e) => e.id) };
}

/** Link `ids` to a style (dropping their overrides), or unlink them when `styleRef` is null. */
export function applyStyle(
  draft: Draft,
  ids: unknown,
  styleRef: unknown,
): StyleResult | UnlinkResult {
  const targets = targetsOf(draft, ids);
  if (styleRef === null) {
    const unlinked: string[] = [];
    for (const el of targets) {
      if (!styleTagOf(el)) continue;
      draft.update(el.id, { customData: withStyleTag(el, null) });
      unlinked.push(el.id);
    }
    return { styleId: null, elementIds: unlinked };
  }
  const style = resolveStyle(draft, styleRef);
  for (const el of targets) draft.update(el.id, { customData: withStyleTag(el, tagFor(style)) });
  syncStyle(style.id, styleDraftAccess(draft));
  return {
    styleId: style.id,
    name: style.name,
    elementIds: stylesOf(draft).find((s) => s.id === style.id)?.elementIds ?? [],
  };
}

export interface StyleUpdate {
  name?: unknown;
  /** Keys to set; `null` removes a key from the style. */
  props?: unknown;
}

/** Change a style's name and/or props; every linked element updates (overrides kept). */
export function updateStyle(draft: Draft, styleRef: unknown, update: StyleUpdate): StyleInfo {
  const style = resolveStyle(draft, styleRef);
  const name = cleanName(update.name) ?? style.name;
  const props: StyleProps = { ...style.props };
  if (update.props !== undefined) {
    const patch = guard(() => normaliseProps(update.props, true));
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete props[k as StyleKey];
      else props[k as StyleKey] = v;
    }
  }
  if (!Object.keys(props).length) throw new ToolError("A style needs at least one property");
  const def: StyleDef = { id: style.id, name, rev: style.rev + 1, props };
  for (const id of style.elementIds) {
    const el = draft.peek(id)!;
    const ov = styleTagOf(el)?.overrides;
    draft.update(id, { customData: withStyleTag(el, tagFor(def, ov)) });
  }
  syncStyle(style.id, styleDraftAccess(draft));
  return stylesOf(draft).find((s) => s.id === style.id)!;
}

/** Remove a style: every element (deleted ones and inert copies included) is unlinked. */
export function deleteStyle(
  draft: Draft,
  styleRef: unknown,
): { styleId: string; unlinked: number } {
  const style = resolveStyle(draft, styleRef);
  let unlinked = 0;
  for (const el of draft.toArray()) {
    if (styleTagOf(el)?.id !== style.id) continue;
    draft.update(el.id, { customData: withStyleTag(el, null) });
    if (!el.isDeleted && !isInstanceChild(el)) unlinked++;
  }
  return { styleId: style.id, unlinked };
}

/** Drop local overrides (all, or `keys`) so the elements follow their style again. */
export function resetStyleOverrides(draft: Draft, ids: unknown, keys?: unknown): number {
  const only = keys === undefined ? null : new Set(keyList(keys));
  const touched = new Set<string>();
  let n = 0;
  for (const el of targetsOf(draft, ids)) {
    const tag = styleTagOf(el);
    if (!tag?.overrides) continue;
    const ov = only
      ? Object.fromEntries(Object.entries(tag.overrides).filter(([k]) => !only.has(k as StyleKey)))
      : {};
    n += Object.keys(tag.overrides).length - Object.keys(ov).length;
    const next: StyleTag = { ...tag, overrides: ov };
    if (!Object.keys(ov).length) delete next.overrides;
    draft.update(el.id, { customData: withStyleTag(el, next) });
    touched.add(tag.id);
  }
  const access = styleDraftAccess(draft);
  for (const sid of touched) syncStyle(sid, access);
  return n;
}

function keyList(keys: unknown): StyleKey[] {
  if (!Array.isArray(keys)) throw new ToolError("keys must be an array of style property names");
  for (const k of keys)
    if (!(STYLE_KEYS as readonly string[]).includes(k))
      throw new ToolError(`Unknown style property "${String(k)}"`);
  return keys as StyleKey[];
}

/** Make an element's overrides part of its style (so every linked element takes them). */
export function pushOverridesToStyle(draft: Draft, elementId: unknown): StyleInfo {
  const el = draft.mustGet(elementId);
  const tag = styleTagOf(el);
  if (!tag || isInstanceChild(el)) throw new ToolError("That element isn't linked to a style");
  if (!tag.overrides || !Object.keys(tag.overrides).length)
    throw new ToolError("That element has no local overrides");
  const cleared = { ...tag };
  delete cleared.overrides;
  draft.update(el.id, { customData: withStyleTag(el, cleared) });
  return updateStyle(draft, tag.id, { props: tag.overrides });
}

/**
 * After generic edits (agent `update_elements`, …): bring the styles those edits touched in line,
 * adopting direct edits to linked elements as overrides (what the live rule does for UI edits).
 */
export function syncStylesEdited(draft: Draft): void {
  if (!draft.changed.size) return;
  const sids = new Set<string>();
  const memory = new Map<string, StyleProps>();
  for (const id of draft.changed) {
    const before = draft.original.get(id);
    if (before) memory.set(id, styleValues(before));
    for (const el of [before, draft.peek(id)]) {
      const t = el && styleTagOf(el);
      if (t) sids.add(t.id);
    }
  }
  if (!sids.size) return;
  const access = styleDraftAccess(draft);
  const changed = new Set(draft.changed);
  for (const sid of sids) syncStyle(sid, access, { changed, memory });
}
