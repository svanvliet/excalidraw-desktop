/**
 * Components data model (plan D-DX2/D-DX3/D-DX11, docs/components.md).
 *
 * Every child of a component carries `customData["excalidrawDesktop.component"]`:
 *  - `role`: "master" (the source on the canvas) or "instance" (a live copy).
 *  - `componentId`: shared by the master and all its instances.
 *  - `slot`: stable key of the master child this element mirrors (the master child's id when it
 *    joined the component). Instance children map 1:1 onto master slots.
 *  - `gi`: index in `groupIds` of the component's group. The master's / an instance's identity
 *    is `groupIds[gi]` (D-DX3): inner groups come before it, user groups around it after it.
 *  - `base` (instances): the master child's geometry relative to the master origin at the last
 *    sync. Comparing it with the instance child's own geometry yields the instance transform.
 *  - `overrides` (instances): explicit per-slot values that win over the master (text, colours,
 *    visibility, …).
 *  - `promoted` (masters): this master was an instance promoted when the master was deleted;
 *    keeps the overrides it had so it can be demoted again if the old master comes back.
 *  - `props` (master and instances, replicated): typed component properties (D-DX11).
 *  - `pv` (instances, replicated across the instance's children): property values.
 *  - `npv` (instances): values for the properties of directly nested instances, keyed by the
 *    nested instance's group id inside the master.
 *  - `source: "library"` + `libraryId`: the master lives in the library, so instances whose
 *    master is absent stay instances (no promotion). `mv` keeps the master's values for the keys
 *    an instance child overrides, and `ms` its look for the keys it can't override, so the
 *    master can be rebuilt from an instance and direct edits to those keys revert. For text,
 *    `ms.fontSize` is the master's (unscaled) font size.
 *  - `fs` (instance text children): the instance's own font size, in master units (the child
 *    shows `fs × scale` instead of the master's size). Set when the user resizes the text of an
 *    instance; it stays local to that instance and never feeds back into the master (FR-67).
 *
 * Nested components (D-DX11): an element can belong to several components at once (an element
 * of an A instance inside B's master). Then the namespace holds `{ v: 2, tags: [...] }`, one tag
 * per component, ordered inner → outer by `gi`. A single tag is stored as before; it is written
 * as `v: 1` unless it uses a v2-only field, so files without the new features stay readable by
 * older builds (which leave v2 data alone instead of rewriting it).
 */
import type { El } from "../reactor/reactor";

export const COMPONENT_NS = "excalidrawDesktop.component";
/** Newest tag version this build reads and writes. */
export const COMPONENT_MODEL_VERSION = 2;

export interface Base {
  /** Centre relative to the master origin. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

/** Keys an instance may override per slot. `fileId` is the image; `visible` hides the slot. */
export const OVERRIDE_KEYS = [
  "text",
  "backgroundColor",
  "strokeColor",
  "opacity",
  "link",
  "fileId",
  "visible",
] as const;
/** Look keys an instance child can't override; library instances record them in `ms`. */
export const LOOK_KEYS = [
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "roundness",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "startArrowhead",
  "endArrowhead",
] as const;

/**
 * Override keys that hold an instance's content rather than its look. "Reset overrides" in the
 * UI keeps them (and property values); they're cleared one slot at a time (FR-67, D-DX21).
 */
export const CONTENT_KEYS: readonly string[] = ["text", "fileId", "link"];

/** `el`'s values for the `LOOK_KEYS` it has, plus a text's font size (see `ms`). */
export function lookOf(el: El): Record<string, unknown> {
  const r = el as unknown as Record<string, unknown>;
  const out = Object.fromEntries(
    LOOK_KEYS.filter((k) => k in r).map((k) => [k, r[k] ?? null]),
  ) as Record<string, unknown>;
  if (el.type === "text" && typeof r.fontSize === "number") out.fontSize = r.fontSize;
  return out;
}

export type OverrideKey = (typeof OVERRIDE_KEYS)[number];
export type Overrides = Partial<Record<OverrideKey, unknown>>;

export const PROP_TYPES = ["text", "color", "boolean", "choice"] as const;
export type PropType = (typeof PROP_TYPES)[number];

/** One slot key a property drives. `map` (choice only): option → value (absent = master's). */
export interface PropBinding {
  slot: string;
  key: OverrideKey;
  map?: Record<string, unknown>;
}

export interface PropDef {
  id: string;
  name: string;
  type: PropType;
  /** boolean: default visibility (true when absent); choice: default option (first option). */
  default?: string | boolean;
  /** choice only. */
  options?: string[];
  bindings: PropBinding[];
}

export type PropValue = string | boolean;
export type PropValues = Record<string, PropValue>;

export interface ComponentTag {
  v: 1 | 2;
  role: "master" | "instance";
  componentId: string;
  slot: string;
  gi: number;
  name?: string;
  base?: Base;
  overrides?: Overrides;
  promoted?: { overrides?: Overrides; base?: Base; pv?: PropValues };
  props?: PropDef[];
  pv?: PropValues;
  npv?: Record<string, PropValues>;
  source?: "library";
  libraryId?: string;
  mv?: Overrides;
  /** The master's look for keys instances can't override (`LOOK_KEYS`), with `mv`. */
  ms?: Record<string, unknown>;
  /** Instance text only: its own font size in master units (see the header). */
  fs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readTag(raw: unknown): ComponentTag | null {
  if (!isRecord(raw) || (raw.v !== 1 && raw.v !== 2)) return null;
  if (raw.role !== "master" && raw.role !== "instance") return null;
  if (typeof raw.componentId !== "string" || typeof raw.slot !== "string") return null;
  if (typeof raw.gi !== "number" || !Number.isInteger(raw.gi) || raw.gi < 0) return null;
  return raw as unknown as ComponentTag;
}

/**
 * Every component tag of the element (inner → outer), [] when it has none, or null when the
 * namespace holds something this build can't read (then the element must be left alone).
 */
export function readTags(el: El | undefined | null): ComponentTag[] | null {
  const raw = el?.customData?.[COMPONENT_NS];
  if (raw === undefined) return [];
  if (isRecord(raw) && Array.isArray(raw.tags)) {
    if (raw.v !== 2) return null;
    const out: ComponentTag[] = [];
    for (const t of raw.tags) {
      const tag = readTag(t);
      if (!tag) return null;
      if (!out.some((o) => o.componentId === tag.componentId)) out.push(tag);
    }
    return out.sort((a, b) => a.gi - b.gi);
  }
  const tag = readTag(raw);
  return tag ? [tag] : null;
}

/** Every readable component tag of the element, inner → outer. */
export function tagsOf(el: El | undefined | null): ComponentTag[] {
  return readTags(el) ?? [];
}

/**
 * The element's outermost component tag (its identity in the UI), or null if it has none (or
 * one this version can't read).
 */
export function tagOf(el: El | undefined | null): ComponentTag | null {
  const tags = tagsOf(el);
  return tags.length ? tags[tags.length - 1] : null;
}

/** The element's tag for one component. */
export function tagFor(el: El | undefined | null, componentId: string): ComponentTag | null {
  return tagsOf(el).find((t) => t.componentId === componentId) ?? null;
}

/** True when the element has a component tag of any version (so we must leave it alone). */
export function hasAnyTag(el: El): boolean {
  return el.customData?.[COMPONENT_NS] !== undefined;
}

/** True when the namespace is absent or readable by this build. */
export function isReadable(el: El): boolean {
  return readTags(el) !== null;
}

/** The component group id (master or instance identity), or null if the group is gone. */
export function groupOf(el: El, tag: ComponentTag | null = tagOf(el)): string | null {
  if (!tag) return null;
  return el.groupIds[tag.gi] ?? null;
}

/** Tags of `el` outside `tag` (larger `gi`). */
export function outerTags(el: El, tag: ComponentTag): ComponentTag[] {
  return tagsOf(el).filter((t) => t.gi > tag.gi);
}

/** Tags of `el` inside `tag` (smaller `gi`). */
export function innerTags(el: El, tag: ComponentTag): ComponentTag[] {
  return tagsOf(el).filter((t) => t.gi < tag.gi);
}

/**
 * True when `el`'s membership of `componentId` is owned by an outer instance: it is a copy of a
 * nested instance inside an instance of another component, which derives it.
 */
export function isOwned(el: El, componentId: string): boolean {
  const tag = tagFor(el, componentId);
  return !!tag && outerTags(el, tag).some((t) => t.role === "instance");
}

/**
 * `customData` with the tag for `tag.componentId` replaced (others kept), or with every tag
 * removed when `tag` is null.
 */
export function withTag(el: El, tag: ComponentTag | null): Record<string, unknown> {
  if (!tag) return writeTags(el, []);
  const rest = tagsOf(el).filter((t) => t.componentId !== tag.componentId);
  return writeTags(el, [...rest, tag]);
}

/** `customData` without the tag for one component. */
export function withoutTag(el: El, componentId: string): Record<string, unknown> {
  return writeTags(
    el,
    tagsOf(el).filter((t) => t.componentId !== componentId),
  );
}

/** `customData` with exactly `tags` (any order). */
export function writeTags(el: El, tags: readonly ComponentTag[]): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(el.customData ?? {}) };
  const clean = [...tags].sort((a, b) => a.gi - b.gi).map(cleanTag);
  if (!clean.length) delete next[COMPONENT_NS];
  else if (clean.length === 1) next[COMPONENT_NS] = clean[0];
  else next[COMPONENT_NS] = { v: 2, tags: clean };
  return next;
}

const nonEmpty = (o: object | undefined): boolean => !!o && Object.keys(o).length > 0;

function needsV2(tag: ComponentTag): boolean {
  return (
    !!tag.props?.length ||
    nonEmpty(tag.pv) ||
    nonEmpty(tag.npv) ||
    (!!tag.overrides && "visible" in tag.overrides) ||
    nonEmpty(tag.promoted?.pv)
  );
}

function cleanTag(tag: ComponentTag): ComponentTag {
  const out: ComponentTag = {
    v: 1,
    role: tag.role,
    componentId: tag.componentId,
    slot: tag.slot,
    gi: tag.gi,
  };
  if (tag.name) out.name = tag.name;
  if (tag.base) out.base = tag.base;
  if (nonEmpty(tag.overrides)) out.overrides = tag.overrides;
  if (tag.promoted) out.promoted = tag.promoted;
  if (tag.props?.length) out.props = tag.props;
  if (nonEmpty(tag.pv)) out.pv = tag.pv;
  if (tag.npv) {
    const npv = Object.fromEntries(Object.entries(tag.npv).filter(([, v]) => nonEmpty(v)));
    if (nonEmpty(npv)) out.npv = npv;
  }
  if (tag.source === "library") out.source = "library";
  if (tag.libraryId) out.libraryId = tag.libraryId;
  if (nonEmpty(tag.mv)) out.mv = tag.mv;
  if (nonEmpty(tag.ms)) out.ms = tag.ms;
  if (typeof tag.fs === "number" && tag.fs > 0) out.fs = tag.fs;
  if (needsV2(out)) out.v = 2;
  return out;
}

/** Deterministic id so peers creating the same instance child converge. */
export function stableId(...parts: string[]): string {
  const s = parts.join("\u0000");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `cmp${h1.toString(36)}${h2.toString(36)}`;
}

/**
 * Content-addressed ids for the inner groups (nested instances, inner groups) of one master or
 * instance of `componentId`: the same inner group gets the same id in every copy (it depends
 * only on the component, the smallest slot inside it and its depth). Masterless components key
 * nested property values (`npv`) by these, and a rebuilt master uses them as its inner groups.
 */
export function canonicalInner(children: readonly El[], componentId: string): Map<string, string> {
  const first = new Map<string, { slot: string; depth: number }>();
  for (const c of children) {
    const t = tagFor(c, componentId);
    if (!t) continue;
    for (let j = 0; j < t.gi; j++) {
      const h = c.groupIds[j];
      const cur = first.get(h);
      if (!cur || t.slot < cur.slot) first.set(h, { slot: t.slot, depth: t.gi - j });
    }
  }
  return new Map(
    [...first].map(([h, v]) => [h, stableId(componentId, "inner", String(v.depth), v.slot)]),
  );
}

/** Public summary of one component (UI + agent). */
export interface ComponentInfo {
  componentId: string;
  name: string | null;
  /** Master group id (select it to select the master), or null when there is no live master. */
  masterGroupId: string | null;
  /** Live master child ids. */
  masterIds: string[];
  instances: Array<{
    groupId: string;
    ids: string[];
    overriddenSlots: number;
    /** Property values set on this instance. */
    values?: PropValues;
    /** The component whose master / instance this instance sits in (nested components). */
    parent?: { componentId: string; role: "master" | "instance"; groupId: string };
  }>;
  /** Declared properties (D-DX11). */
  props: PropDef[];
  /** Components with instances nested in this component (its master, or its instances). */
  uses: string[];
  /** "library" when the master lives in the library (no promotion of orphans). */
  source?: "library";
  libraryId?: string;
}

/** Info about the component an element belongs to, as seen from that element. */
export interface ElementComponentInfo {
  componentId: string;
  role: "master" | "instance";
  slot: string;
  groupId: string | null;
  name?: string;
  overrides?: Overrides;
  props?: PropDef[];
  values?: PropValues;
  source?: "library";
  libraryId?: string;
  /** Inner memberships (nested component instances this element is part of), inner → outer. */
  nested?: Array<{
    componentId: string;
    role: "master" | "instance";
    slot: string;
    groupId: string | null;
    name?: string;
  }>;
}

export function elementComponentInfo(el: El): ElementComponentInfo | null {
  const tags = tagsOf(el);
  const tag = tags[tags.length - 1];
  if (!tag) return null;
  const out: ElementComponentInfo = {
    componentId: tag.componentId,
    role: tag.role,
    slot: tag.slot,
    groupId: groupOf(el, tag),
  };
  if (tag.name) out.name = tag.name;
  if (nonEmpty(tag.overrides)) out.overrides = tag.overrides;
  if (tag.props?.length) out.props = tag.props;
  if (nonEmpty(tag.pv)) out.values = tag.pv;
  if (tag.source) out.source = tag.source;
  if (tag.libraryId) out.libraryId = tag.libraryId;
  if (tags.length > 1)
    out.nested = tags.slice(0, -1).map((t) => ({
      componentId: t.componentId,
      role: t.role,
      slot: t.slot,
      groupId: groupOf(el, t),
      ...(t.name ? { name: t.name } : {}),
    }));
  return out;
}

/** Every component in a scene (live elements only). */
export function listComponents(elements: readonly El[]): ComponentInfo[] {
  const byId = new Map<string, ComponentInfo>();
  const instanceIdx = new Map<string, Map<string, ComponentInfo["instances"][number]>>();
  const pendingUses: Array<[string, string]> = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    const tags = tagsOf(el);
    tags.forEach((tag, i) => {
      const group = groupOf(el, tag);
      if (!group) return;
      let info = byId.get(tag.componentId);
      if (!info) {
        info = {
          componentId: tag.componentId,
          name: null,
          masterGroupId: null,
          masterIds: [],
          instances: [],
          props: [],
          uses: [],
        };
        byId.set(tag.componentId, info);
        instanceIdx.set(tag.componentId, new Map());
      }
      if (tag.name && (tag.role === "master" || !info.name)) info.name = tag.name;
      if (tag.source) info.source = tag.source;
      if (tag.libraryId) info.libraryId ??= tag.libraryId;
      const outer = tags[i + 1];
      if (tag.role === "master") {
        info.masterGroupId ??= group;
        if (info.masterGroupId === group) {
          info.masterIds.push(el.id);
          if (tag.props?.length && !info.props.length) info.props = tag.props;
        }
      } else {
        const idx = instanceIdx.get(tag.componentId)!;
        let inst = idx.get(group);
        if (!inst) idx.set(group, (inst = { groupId: group, ids: [], overriddenSlots: 0 }));
        inst.ids.push(el.id);
        if (nonEmpty(tag.overrides)) inst.overriddenSlots++;
        if (nonEmpty(tag.pv)) inst.values ??= tag.pv;
        const og = outer && groupOf(el, outer);
        if (outer && og)
          inst.parent ??= { componentId: outer.componentId, role: outer.role, groupId: og };
        if (!info.props.length && tag.props?.length) info.props = tag.props;
      }
      // Nested in a master, or in an instance of a component whose master is off-canvas.
      if (outer) {
        const parent = byId.get(outer.componentId);
        if (parent && !parent.uses.includes(tag.componentId)) parent.uses.push(tag.componentId);
        else if (!parent) pendingUses.push([outer.componentId, tag.componentId]);
      }
    });
  }
  for (const [p, c] of pendingUses) {
    const parent = byId.get(p);
    if (parent && !parent.uses.includes(c)) parent.uses.push(c);
  }
  for (const [cid, info] of byId) {
    info.instances = [...instanceIdx.get(cid)!.values()];
    info.instances.sort((a, b) => (a.groupId < b.groupId ? -1 : 1));
    info.uses.sort();
  }
  return [...byId.values()];
}

/**
 * Component dependency graph: `B → A` when B's master contains (a copy of) a component A.
 * Nesting must stay acyclic.
 */
export function componentDeps(elements: readonly El[]): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const tags = tagsOf(el);
    for (let i = 0; i < tags.length; i++) {
      const outer = tags[i];
      if (outer.role !== "master") continue;
      for (const inner of tags.slice(0, i)) {
        let set = deps.get(outer.componentId);
        if (!set) deps.set(outer.componentId, (set = new Set()));
        set.add(inner.componentId);
      }
    }
  }
  return deps;
}

/** True when `from` (transitively) depends on `to`, or they are the same component. */
export function dependsOn(
  deps: ReadonlyMap<string, ReadonlySet<string>>,
  from: string,
  to: string,
): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const c = stack.pop()!;
    if (c === to) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    for (const d of deps.get(c) ?? []) stack.push(d);
  }
  return false;
}

/** Component ids ordered inner (dependencies) first. */
export function topoOrder(
  ids: Iterable<string>,
  deps: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (c: string) => {
    if (state.get(c)) return;
    state.set(c, 1);
    for (const d of [...(deps.get(c) ?? [])].sort()) visit(d);
    state.set(c, 2);
    out.push(c);
  };
  const want = new Set(ids);
  for (const c of [...want].sort()) visit(c);
  return out.filter((c) => want.has(c));
}
