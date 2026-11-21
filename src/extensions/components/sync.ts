/**
 * Components sync: makes every instance of one component match its master. Used by the reactor
 * rule (live, `CaptureUpdateAction.NEVER`) and by the draft-level actions (so their single undo
 * step already contains a consistent scene). Pure over a small access interface.
 *
 * Per component:
 *  1. Elements whose component group is gone (ungrouped) lose that component's tag (detached).
 *  2. No live master → the instance with the smallest group id (not nested ones first) is
 *     promoted (keeps its look), unless the component lives in the library (`source: "library"`)
 *     — then instances stay self-contained copies. Several live masters (undo of a delete,
 *     collab) → the non-promoted one with the smallest group id wins; others are demoted back.
 *  3. Elements drawn/pasted into the master group are adopted as new master children (instances
 *     of other components too — nesting — unless that would make a cycle).
 *  4. Every live instance gets one child per live master slot (created with a deterministic id
 *     or undeleted) and loses children whose slot is gone. Children are derived from the master
 *     under the instance's inferred transform, with its effective overrides applied: values of
 *     nested-component properties (`npv`) ← component property values (`pv`) ← explicit
 *     overrides. Direct edits to overridable keys become property values (keys bound to a text or
 *     colour property) or overrides; any other direct edit is reverted. Slots resolved to
 *     `visible: false` are soft-deleted.
 *
 * Instances of other components inside an instance ("owned", see `isOwned`) are derived by the
 * outer component as copies of the nested instance in its master; their own component skips them.
 * `syncComponent` returns the components that must sync next (outer masters whose content
 * changed), which `syncCascade` follows.
 */
import { newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { El, Patch } from "../reactor/reactor";
import {
  baseOf,
  inferTransform,
  isBoundText,
  isPointy,
  originOf,
  placeGeometry,
  translation,
  type Transform,
} from "./geometry";
import {
  groupOf,
  innerTags,
  isOwned,
  OVERRIDE_KEYS,
  outerTags,
  readTags,
  stableId,
  tagFor,
  tagsOf,
  withoutTag,
  withTag,
  writeTags,
  type Base,
  type ComponentTag,
  type OverrideKey,
  type Overrides,
  type PropDef,
  type PropValues,
} from "./model";
import { layoutBoundText, measureFreeText } from "./text";

type TextEl = ExcalidrawTextElement;

export interface SyncAccess {
  /** Any element (deleted included), with this sync's own writes applied. */
  get(id: string): El | undefined;
  /** Elements of the component (deleted included) plus untagged elements in its master group. */
  members(componentId: string): El[];
  patch(id: string, patch: Patch): void;
  add(el: El, afterId?: string): void;
}

export interface SyncOptions {
  /** Elements the user changed directly since the last sync (instance children only matter). */
  changed?: ReadonlySet<string>;
  /**
   * Last overridable values seen per instance child. When present, only keys whose value
   * really changed since then are adopted as overrides.
   */
  memory?: Map<string, Record<string, unknown>>;
}

const EMPTY = new Set<string>();

const STYLE_KEYS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "link",
] as const;
const TEXT_KEYS = ["fontFamily", "textAlign", "verticalAlign", "lineHeight", "autoResize"] as const;
const IMAGE_KEYS = ["fileId", "scale", "crop", "status"] as const;
const LINEAR_KEYS = ["startArrowhead", "endArrowhead", "elbowed", "polygon"] as const;
const FREEDRAW_KEYS = ["pressures", "simulatePressure"] as const;

/** Whether `key` can be overridden on a child of this type. */
export function overridable(el: El, key: OverrideKey): boolean {
  if (key === "text") return el.type === "text";
  if (key === "fileId") return el.type === "image";
  return true;
}

function rec(el: El): Record<string, unknown> {
  return el as unknown as Record<string, unknown>;
}

export function masterValue(m: El, key: OverrideKey): unknown {
  if (key === "visible") return true;
  return key === "text" ? (m as TextEl).originalText : rec(m)[key];
}

export function currentValue(c: El, key: OverrideKey): unknown {
  if (key === "visible") return !c.isDeleted;
  return key === "text" ? (c as TextEl).originalText : rec(c)[key];
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Overrides minus keys that don't apply to `m` or equal the master value. */
export function cleanOverrides(m: El, ov: Overrides | undefined): Overrides | undefined {
  if (!ov) return undefined;
  const out: Overrides = {};
  for (const k of OVERRIDE_KEYS) {
    if (!(k in ov) || !overridable(m, k)) continue;
    if (same(ov[k], masterValue(m, k))) continue;
    out[k] = ov[k];
  }
  return Object.keys(out).length ? out : undefined;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Property-driven overrides for `slot`. `explicitOnly`: only values actually set apply. */
export function propOverrides(
  defs: readonly PropDef[] | undefined,
  values: PropValues | undefined,
  slot: string,
  explicitOnly = false,
): Overrides {
  const out: Overrides = {};
  for (const def of defs ?? []) {
    const set = values?.[def.id];
    for (const b of def.bindings) {
      if (b.slot !== slot) continue;
      if (def.type === "text" || def.type === "color") {
        if (typeof set === "string") out[b.key] = set;
      } else if (def.type === "boolean") {
        const v = explicitOnly ? set : (set ?? def.default ?? true);
        if (v === false) out.visible = false;
      } else {
        const v = explicitOnly ? set : (set ?? def.default ?? def.options?.[0]);
        if (typeof v === "string" && b.map && v in b.map) out[b.key] = b.map[v];
      }
    }
  }
  return out;
}

/** The text/colour property bound to `slot`.`key`, if any (direct edits update its value). */
function valueProp(defs: readonly PropDef[], slot: string, key: OverrideKey): PropDef | undefined {
  return defs.find(
    (d) =>
      (d.type === "text" || d.type === "color") &&
      d.bindings.some((b) => b.slot === slot && b.key === key),
  );
}

/** A replicated per-instance field, read from the live child with the newest version. */
function newest<T>(children: readonly El[], read: (el: El) => T | undefined): T | undefined {
  let best: El | undefined;
  for (const c of children) {
    if (read(c) === undefined) continue;
    if (
      !best ||
      Number(!c.isDeleted) - Number(!best.isDeleted) > 0 ||
      (c.isDeleted === best.isDeleted &&
        (c.version > best.version || (c.version === best.version && c.id < best.id)))
    )
      best = c;
  }
  return best && read(best);
}

/** Property values of an instance (replicated on its children). */
export function instanceValues(children: readonly El[], componentId: string): PropValues {
  return { ...(newest(children, (c) => tagFor(c, componentId)?.pv) ?? {}) };
}

/** Nested property values of an instance. */
export function instanceNested(
  children: readonly El[],
  componentId: string,
): Record<string, PropValues> {
  return { ...(newest(children, (c) => tagFor(c, componentId)?.npv) ?? {}) };
}

/** Pick the instance's transform from its children, preferring ones the user didn't touch. */
function chooseTransform(
  children: readonly El[],
  componentId: string,
  changed: ReadonlySet<string>,
): Transform {
  const baseOfTag = (c: El) => tagFor(c, componentId)?.base;
  const cands = children.filter((c) => !c.isDeleted && !isBoundText(c) && baseOfTag(c));
  if (!cands.length) return translation(originOf(children.filter((c) => !c.isDeleted)));
  const area = (c: El) => {
    const b = baseOfTag(c)!;
    return Math.abs(b.w * b.h);
  };
  cands.sort(
    (a, b) =>
      Number(changed.has(a.id)) - Number(changed.has(b.id)) ||
      Number(a.type === "text") - Number(b.type === "text") ||
      area(b) - area(a) ||
      byId(a.id, b.id),
  );
  const ref = cands[0];
  return inferTransform(ref, baseOfTag(ref)!);
}

function withoutUndefined(p: Patch): Patch {
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p;
}

interface InstanceCtx {
  group: string;
  t: Transform;
  /** master slot → instance child id */
  idOf: Map<string, string>;
  /** ids of every child of this instance */
  ids: Set<string>;
  innerMap: Map<string, string>;
  outer: string[];
  frameId: string | null;
  /** Slots resolved to `visible: false`. */
  hidden: Set<string>;
  pv: PropValues;
  npv: Record<string, PropValues>;
}

interface MasterCtx {
  componentId: string;
  name?: string;
  props: PropDef[];
  source?: "library";
  libraryId?: string;
  bySlot: Map<string, El>;
  slotOfId: Map<string, string>;
  bases: Map<string, Base>;
  /** Slots in processing order: containers before their bound text. */
  order: string[];
}

/** The nested instance tag directly inside `m`'s tag for the component, if any. */
function directInner(m: El, mt: ComponentTag): ComponentTag | undefined {
  const inner = innerTags(m, mt);
  return inner[inner.length - 1];
}

/** Overrides coming from nested-component property values set on this instance. */
function nestedOverrides(m: El, mt: ComponentTag, npv: Record<string, PropValues>): Overrides {
  const d = directInner(m, mt);
  const g = d && groupOf(m, d);
  if (!d || !g || !npv[g]) return {};
  // Only values actually set apply; `visible: true` can't reveal a slot hidden in the master.
  return propOverrides(d.props, npv[g], d.slot, true);
}

/** Everything about `m`'s instance copy except geometry of bound text. */
function deriveChild(
  m: El,
  c: El | undefined,
  effective: Overrides,
  explicit: Overrides,
  mc: MasterCtx,
  ic: InstanceCtx,
  access: SyncAccess,
): Patch {
  const slot = mc.slotOfId.get(m.id)!;
  const base = mc.bases.get(slot)!;
  const mr = rec(m);
  const ov = cleanOverrides(m, effective);
  const p: Patch = {};
  for (const k of STYLE_KEYS) if (k in mr) p[k] = mr[k];
  if (m.type === "image") for (const k of IMAGE_KEYS) if (k in mr) p[k] = mr[k];
  if (m.type === "arrow" || m.type === "line")
    for (const k of LINEAR_KEYS) if (k in mr) p[k] = mr[k];
  if (m.type === "freedraw") for (const k of FREEDRAW_KEYS) if (k in mr) p[k] = mr[k];
  for (const k of ["backgroundColor", "strokeColor", "opacity", "link", "fileId"] as const)
    if (ov && k in ov && overridable(m, k)) p[k] = ov[k];

  Object.assign(p, placeGeometry(m, base, ic.t));

  const internalId = (id: string | null | undefined) => {
    const s = id ? mc.slotOfId.get(id) : undefined;
    return s && !ic.hidden.has(s) ? ic.idOf.get(s) : undefined;
  };
  if (m.type === "arrow" || m.type === "line") {
    const cr = c ? rec(c) : {};
    for (const end of ["startBinding", "endBinding"] as const) {
      const mb = mr[end] as { elementId: string } | null | undefined;
      const cb = cr[end] as { elementId: string } | null | undefined;
      const mapped = internalId(mb?.elementId);
      if (mb && mapped) p[end] = { ...mb, elementId: mapped };
      else if (cb && !ic.ids.has(cb.elementId)) p[end] = cb;
      else p[end] = null;
    }
  }
  const internal = (m.boundElements ?? [])
    .map((b) => ({ id: internalId(b.id), type: b.type }))
    .filter((b): b is { id: string; type: typeof b.type } => !!b.id);
  const external = (c?.boundElements ?? []).filter((b) => !ic.ids.has(b.id));
  const bound = [...internal, ...external];
  p.boundElements = bound.length ? bound : null;

  if (m.type === "text") {
    const mt = m as TextEl;
    const scale = Math.min(ic.t.sx, ic.t.sy);
    for (const k of TEXT_KEYS) if (k in mr) p[k] = mr[k];
    p.fontSize = Math.round(mt.fontSize * scale * 1000) / 1000;
    const text = typeof ov?.text === "string" ? ov.text : mt.originalText;
    const style = { ...mt, fontSize: p.fontSize } as TextEl;
    const containerId = mt.containerId
      ? (ic.idOf.get(mc.slotOfId.get(mt.containerId) ?? "") ?? null)
      : null;
    p.containerId = containerId;
    const container = containerId ? access.get(containerId) : undefined;
    const laid = container && layoutBoundText(container, style, text);
    if (laid) {
      Object.assign(p, laid.text);
      if (laid.containerHeight > container.height + 0.01) {
        access.patch(container.id, { height: laid.containerHeight });
        const again = layoutBoundText(access.get(container.id)!, style, text);
        if (again) Object.assign(p, again.text);
      }
    } else if (mt.autoResize === false && !containerId) {
      p.text = typeof ov?.text === "string" ? ov.text : mt.text;
      p.originalText = text;
    } else {
      const meas = measureFreeText(style, text);
      const boxW = p.width as number;
      const left = (p.x as number) + boxW / 2 - (mt.textAlign === "center" ? meas.width / 2 : 0);
      const x =
        mt.textAlign === "center"
          ? left
          : mt.textAlign === "right"
            ? (p.x as number) + boxW - meas.width
            : (p.x as number);
      const cy = (p.y as number) + (p.height as number) / 2;
      Object.assign(p, {
        x: containerId ? (p.x as number) + boxW / 2 - meas.width / 2 : x,
        y: cy - meas.height / 2,
        width: meas.width,
        height: meas.height,
        text: meas.text,
        originalText: text,
      });
    }
  }

  const mt = tagFor(m, mc.componentId)!;
  const ct = c ? tagFor(c, mc.componentId) : null;
  const tag: ComponentTag = {
    v: 1,
    role: "instance",
    componentId: mc.componentId,
    slot,
    gi: ct?.gi ?? mt.gi,
    base,
  };
  if (mc.name) tag.name = mc.name;
  const explicitClean = cleanOverrides(m, explicit);
  if (explicitClean) tag.overrides = explicitClean;
  if (mc.props.length) tag.props = mc.props;
  if (Object.keys(ic.pv).length) tag.pv = ic.pv;
  if (Object.keys(ic.npv).length) tag.npv = ic.npv;
  if (mc.source) {
    tag.source = mc.source;
    if (mc.libraryId) tag.libraryId = mc.libraryId;
    // The master's values for every key this child overrides (to rebuild it from here).
    if (ov)
      tag.mv = Object.fromEntries(
        Object.keys(ov).map((k) => [k, masterValue(m, k as OverrideKey)]),
      );
  }
  // Inner tags (nested instances) are copies of the master child's, as instances.
  const d = directInner(m, mt);
  const inner =
    tag.gi === mt.gi
      ? innerTags(m, mt).map((t) => {
          const out: ComponentTag = { ...t, role: "instance", promoted: undefined };
          const g = t === d ? groupOf(m, t) : null;
          if (g && ic.npv[g]) out.pv = { ...(t.pv ?? {}), ...ic.npv[g] };
          return out;
        })
      : c && ct
        ? innerTags(c, ct)
        : [];
  const outer = c && ct ? outerTags(c, ct) : [];
  p.customData = writeTags(c ?? m, [...inner, tag, ...outer]);
  return withoutUndefined(p);
}

/** A new instance child for `m` (id deterministic from instance group + slot). */
function newChild(m: El, gi: number, id: string, ic: InstanceCtx): El {
  const inner = m.groupIds.slice(0, gi).map((g) => {
    let mapped = ic.innerMap.get(g);
    if (!mapped) ic.innerMap.set(g, (mapped = stableId(ic.group, g)));
    return mapped;
  });
  const draft = {
    ...m,
    id,
    groupIds: [...inner, ic.group, ...ic.outer],
    frameId: ic.frameId,
    locked: false,
    isDeleted: false,
    index: null,
    boundElements: null,
    customData: undefined,
    version: 1,
    versionNonce: 0,
    updated: Date.now(),
  } as unknown as El;
  return newElementWith(draft, {}, true);
}

/** Members of `componentId` in a plain element list (for drafts / tests). */
export function componentMembers(elements: readonly El[], componentId: string): El[] {
  const masterGroups = new Set<string>();
  for (const el of elements) {
    const tag = tagFor(el, componentId);
    if (tag?.role === "master" && !el.isDeleted) {
      const g = groupOf(el, tag);
      if (g) masterGroups.add(g);
    }
  }
  return elements.filter((el) => {
    const tags = readTags(el);
    if (!tags) return false;
    if (tags.some((t) => t.componentId === componentId)) return true;
    return !el.isDeleted && el.groupIds.some((g) => masterGroups.has(g));
  });
}

/** True when component `from` (transitively) nests `to`, or is `to`. */
export function nests(access: Pick<SyncAccess, "members">, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cid = stack.pop()!;
    if (cid === to) return true;
    if (seen.has(cid)) continue;
    seen.add(cid);
    for (const el of access.members(cid)) {
      if (el.isDeleted) continue;
      const mt = tagFor(el, cid);
      if (mt?.role !== "master") continue;
      for (const t of innerTags(el, mt)) stack.push(t.componentId);
    }
  }
  return false;
}

function isHiddenTag(tag: ComponentTag, pv: PropValues): boolean {
  const ov = { ...propOverrides(tag.props, pv, tag.slot), ...(tag.overrides ?? {}) };
  return ov.visible === false;
}

/**
 * Sync one component. Returns the other components that must sync because of what this wrote
 * (outer components whose master content changed, inner ones that stopped being owned).
 */
export function syncComponent(
  componentId: string,
  access0: SyncAccess,
  opts: SyncOptions = {},
): Set<string> {
  const changed = opts.changed ?? EMPTY;
  const next = new Set<string>();
  const written = new Set<string>();
  const access: SyncAccess = {
    get: access0.get,
    members: access0.members,
    patch(id, p) {
      const before = access0.get(id);
      access0.patch(id, p);
      if (access0.get(id) !== before) written.add(id);
    },
    add(el, after) {
      access0.add(el, after);
      written.add(el.id);
    },
  };
  const T = (el: El) => tagFor(el, componentId);
  const masters = new Map<string, El[]>();
  const instances = new Map<string, El[]>();
  const untagged: El[] = [];
  let library = false;
  const latest = (el: El) => access.get(el.id) ?? el;

  for (const el of access.members(componentId)) {
    const tags = readTags(el);
    if (!tags) continue;
    const tag = tags.find((t) => t.componentId === componentId);
    if (!tag) {
      if (!el.isDeleted) untagged.push(el);
      continue;
    }
    if (tag.source === "library") library = true;
    const g = groupOf(el, tag);
    if (!g) {
      // Ungrouped out of its component: it's an ordinary element (for this component) now.
      if (!el.isDeleted) {
        access.patch(el.id, { customData: withoutTag(el, componentId) });
        for (const t of tags) if (t.componentId !== componentId) next.add(t.componentId);
      }
      continue;
    }
    if (tag.role === "instance" && isOwned(el, componentId)) continue; // derived by its owner
    push(tag.role === "master" ? masters : instances, g, el);
  }
  const isLive = (els: readonly El[]) => els.some((e) => !e.isDeleted);
  const finish = () => {
    for (const id of written) {
      const el = access.get(id);
      if (!el) continue;
      const t = T(el);
      for (const o of tagsOf(el))
        if (o.componentId !== componentId && (!t || o.gi > t.gi)) next.add(o.componentId);
    }
    next.delete(componentId);
    return next;
  };

  // --- 2. one live master ---------------------------------------------------------------------
  let liveMasters = [...masters].filter(([, els]) => isLive(els)).map(([g]) => g);
  if (!liveMasters.length) {
    // A library component's master lives off-canvas: instances stay self-contained copies.
    if (library) return finish();
    const cands = [...instances].filter(([, els]) => isLive(els)).map(([g]) => g);
    if (!cands.length) return finish();
    const depth = (g: string) => {
      const el = instances.get(g)!.find((e) => !e.isDeleted)!;
      return outerTags(el, T(el)!).length;
    };
    cands.sort((a, b) => depth(a) - depth(b) || byId(a, b));
    const g = cands[0];
    const els = instances.get(g)!;
    const pv = instanceValues(els, componentId);
    for (const el of els) {
      const tag = T(el)!;
      const reveal = el.isDeleted && isHiddenTag(tag, pv);
      if (el.isDeleted && !reveal) continue;
      const promoted: ComponentTag["promoted"] = { overrides: tag.overrides ?? {} };
      if (tag.base) promoted.base = tag.base;
      if (Object.keys(pv).length) promoted.pv = pv;
      access.patch(el.id, {
        ...(reveal ? { isDeleted: false } : {}),
        customData: withTag(el, {
          ...tag,
          role: "master",
          base: undefined,
          overrides: undefined,
          pv: undefined,
          npv: undefined,
          mv: undefined,
          promoted,
        }),
      });
      for (const t of innerTags(el, tag)) next.add(t.componentId);
    }
    instances.delete(g);
    masters.set(g, els.map(latest));
    liveMasters = [g];
  }
  const isPromoted = (g: string) => masters.get(g)!.some((e) => !!T(latest(e))?.promoted);
  liveMasters.sort((a, b) => Number(isPromoted(a)) - Number(isPromoted(b)) || byId(a, b));
  const masterGroup = liveMasters[0];
  for (const g of liveMasters.slice(1)) {
    const els = masters.get(g)!.map(latest);
    const origin = originOf(els.filter((e) => !e.isDeleted));
    for (const el of els) {
      const tag = T(el)!;
      const promoted = tag.promoted;
      access.patch(el.id, {
        customData: withTag(el, {
          ...tag,
          role: "instance",
          promoted: undefined,
          base: promoted?.base ?? baseOf(el, origin),
          overrides: promoted?.overrides,
          pv: promoted?.pv,
        }),
      });
    }
    masters.delete(g);
    instances.set(g, els.map(latest));
  }

  // --- 3. master children (adopt + dedupe slots) ---------------------------------------------
  const masterEls = masters.get(masterGroup)!.map(latest);
  const liveTags = masterEls.filter((e) => !e.isDeleted).map((e) => T(e)!);
  const name = liveTags.map((t) => t.name).find(Boolean);
  const props = liveTags.find((t) => t.props?.length)?.props ?? [];
  const libTag = liveTags.find((t) => t.source === "library");
  for (const el of untagged) {
    const gi = el.groupIds.indexOf(masterGroup);
    if (gi < 0) continue;
    let tags = tagsOf(el);
    // Masters of other components can't be nested; nor can tags that sit outside this group.
    if (tags.some((t) => t.role === "master" || t.gi >= gi)) continue;
    // Nesting must stay acyclic: drop memberships that (transitively) contain this component.
    const cyclic = tags.filter((t) => nests(access, t.componentId, componentId));
    if (cyclic.length) tags = tags.filter((t) => !cyclic.includes(t));
    const tag: ComponentTag = { v: 1, role: "master", componentId, slot: el.id, gi };
    if (name) tag.name = name;
    if (props.length) tag.props = props;
    if (libTag) {
      tag.source = "library";
      if (libTag.libraryId) tag.libraryId = libTag.libraryId;
    }
    access.patch(el.id, { customData: writeTags(el, [...tags, tag]) });
    masterEls.push(latest(el));
  }
  const mc: MasterCtx = {
    componentId,
    name,
    props,
    source: libTag ? "library" : undefined,
    libraryId: libTag?.libraryId,
    bySlot: new Map(),
    slotOfId: new Map(),
    bases: new Map(),
    order: [],
  };
  const liveMaster = masterEls.filter((e) => !e.isDeleted);
  liveMaster.sort((a, b) => byId(a.id, b.id));
  for (const el of liveMaster) {
    const tag = T(el)!;
    let slot = tag.slot;
    const fix: Partial<ComponentTag> = {};
    if (mc.bySlot.has(slot)) slot = fix.slot = el.id;
    if (JSON.stringify(tag.props ?? []) !== JSON.stringify(props))
      fix.props = props.length ? props : undefined;
    if (Object.keys(fix).length)
      access.patch(el.id, { customData: withTag(el, { ...tag, ...fix }) });
    mc.bySlot.set(slot, latest(el));
    mc.slotOfId.set(el.id, slot);
  }
  const origin = originOf([...mc.bySlot.values()]);
  for (const [slot, el] of mc.bySlot) mc.bases.set(slot, baseOf(el, origin));
  // Scene order keeps creation deterministic; containers before bound text.
  const sceneOrder = masterEls.map((e) => e.id);
  mc.order = [...mc.bySlot.keys()].sort((a, b) => {
    const ea = mc.bySlot.get(a)!;
    const eb = mc.bySlot.get(b)!;
    return (
      Number(isBoundText(ea)) - Number(isBoundText(eb)) ||
      sceneOrder.indexOf(ea.id) - sceneOrder.indexOf(eb.id)
    );
  });

  // --- 4. instances ---------------------------------------------------------------------------
  const groups = [...instances.keys()].sort(byId);
  for (const group of groups) {
    const children = instances.get(group)!.map(latest);
    if (!isLive(children)) continue; // the whole instance was deleted
    const writesBefore = written.size;
    const bySlot = new Map<string, El>();
    for (const c of [...children].sort((a, b) => Number(a.isDeleted) - Number(b.isDeleted))) {
      const slot = T(c)!.slot;
      if (!bySlot.has(slot)) bySlot.set(slot, c);
      else if (!c.isDeleted) access.patch(c.id, { customData: withoutTag(c, componentId) });
    }
    const anyLive = children.find((c) => !c.isDeleted)!;
    const anyTag = T(anyLive)!;
    const ic: InstanceCtx = {
      group,
      t: chooseTransform(children, componentId, changed),
      idOf: new Map(),
      ids: new Set(children.map((c) => c.id)),
      innerMap: new Map(),
      outer: anyLive.groupIds.slice(anyTag.gi + 1),
      frameId: anyLive.frameId,
      hidden: new Set(),
      pv: instanceValues(children, componentId),
      npv: instanceNested(children, componentId),
    };
    for (const slot of mc.order) {
      const id = bySlot.get(slot)?.id ?? stableId(group, slot);
      ic.idOf.set(slot, id);
      ic.ids.add(id);
      const c = bySlot.get(slot);
      const m = mc.bySlot.get(slot)!;
      const mt = T(m);
      const ct = c && T(c);
      if (c && mt && ct) {
        for (let i = 0; i < Math.min(mt.gi, ct.gi); i++)
          if (!ic.innerMap.has(m.groupIds[i])) ic.innerMap.set(m.groupIds[i], c.groupIds[i]);
      }
    }

    // Pass 1: current children and direct edits (which may set property values).
    const current = new Map<string, El | undefined>();
    const explicit = new Map<string, Overrides>();
    for (const slot of mc.order) {
      let c = bySlot.get(slot);
      if (!c) {
        const existing = access.get(ic.idOf.get(slot)!);
        if (existing && T(existing)) c = existing;
      }
      current.set(slot, c);
      explicit.set(slot, { ...((c && T(c)?.overrides) ?? {}) });
    }
    const effectiveOf = (slot: string): Overrides => {
      const m = mc.bySlot.get(slot)!;
      return {
        ...nestedOverrides(m, T(m)!, ic.npv),
        ...propOverrides(mc.props, ic.pv, slot),
        ...explicit.get(slot)!,
      };
    };
    for (const slot of mc.order) {
      const c = current.get(slot);
      if (!c || c.isDeleted || !changed.has(c.id)) continue;
      const m = mc.bySlot.get(slot)!;
      adoptEdit(m, c, slot, explicit.get(slot)!, effectiveOf, mc.props, ic.pv, opts.memory);
    }

    // Visibility: bound text follows its container; at least one slot stays visible.
    const effective = new Map(mc.order.map((s) => [s, effectiveOf(s)]));
    for (const slot of mc.order) {
      const m = mc.bySlot.get(slot)!;
      const container =
        isBoundText(m) && (m as TextEl).containerId
          ? mc.slotOfId.get((m as TextEl).containerId!)
          : undefined;
      if (effective.get(slot)!.visible === false || (container && ic.hidden.has(container)))
        ic.hidden.add(slot);
    }
    const shown = mc.order.filter((s) => !isBoundText(mc.bySlot.get(s)!));
    if (shown.length && shown.every((s) => ic.hidden.has(s))) {
      ic.hidden.delete(shown[0]);
      for (const s of mc.order) {
        const m = mc.bySlot.get(s)!;
        if ((m as TextEl).containerId && mc.slotOfId.get((m as TextEl).containerId!) === shown[0])
          if (effective.get(s)!.visible !== false) ic.hidden.delete(s);
      }
    }

    // Pass 2: derive.
    let last = children[children.length - 1].id;
    for (const slot of mc.order) {
      const m = mc.bySlot.get(slot)!;
      const c = current.get(slot);
      const id = ic.idOf.get(slot)!;
      const patch = deriveChild(m, c, effective.get(slot)!, explicit.get(slot)!, mc, ic, access);
      const isDeleted = ic.hidden.has(slot);
      if (!c) {
        const el = newElementWith(newChild(m, T(m)!.gi, id, ic), patch as never, true);
        access.add(isDeleted ? newElementWith(el, { isDeleted: true }, true) : el, last);
      } else {
        access.patch(c.id, { ...patch, isDeleted });
      }
      last = id;
    }
    for (const [slot, c] of bySlot) {
      if (!mc.bySlot.has(slot) && !c.isDeleted) access.patch(c.id, { isDeleted: true });
    }
    if (written.size > writesBefore)
      for (const t of outerTags(anyLive, anyTag)) next.add(t.componentId);
    if (opts.memory) {
      for (const id of ic.idOf.values()) {
        const el = access.get(id);
        if (!el) continue;
        const snap: Record<string, unknown> = {};
        for (const k of OVERRIDE_KEYS) snap[k] = currentValue(el, k);
        opts.memory.set(id, snap);
      }
    }
  }
  return finish();
}

/**
 * Direct edits to overridable keys of an instance child: keys bound to a text/colour property
 * update its value (`pv`, mutated); others become explicit overrides (`explicit`, mutated).
 */
function adoptEdit(
  m: El,
  c: El,
  slot: string,
  explicit: Overrides,
  effectiveOf: (slot: string) => Overrides,
  props: readonly PropDef[],
  pv: PropValues,
  memory: Map<string, Record<string, unknown>> | undefined,
): void {
  const prev = memory?.get(c.id);
  for (const k of OVERRIDE_KEYS) {
    if (k === "visible") continue;
    if (!overridable(m, k) || (k === "text" && c.type !== "text")) continue;
    const cur = currentValue(c, k);
    if (prev && same(cur, prev[k])) continue;
    const eff = effectiveOf(slot);
    if (same(cur, k in eff ? eff[k] : masterValue(m, k))) continue;
    const prop = valueProp(props, slot, k);
    if (prop && typeof cur === "string") {
      pv[prop.id] = cur;
      delete explicit[k];
      continue;
    }
    delete explicit[k];
    const without = effectiveOf(slot);
    if (!same(cur, k in without ? without[k] : masterValue(m, k))) explicit[k] = cur;
  }
}

/**
 * Sync `componentIds` and everything their writes affect (outer components nesting them), until
 * stable. Dependencies are acyclic, so this terminates; a run cap guards against bad data.
 */
export function syncCascade(
  componentIds: Iterable<string>,
  access: SyncAccess,
  opts: SyncOptions = {},
): void {
  const queue = [...new Set(componentIds)].sort();
  const runs = new Map<string, number>();
  while (queue.length) {
    const cid = queue.shift()!;
    const n = runs.get(cid) ?? 0;
    if (n >= 8) continue;
    runs.set(cid, n + 1);
    for (const other of syncComponent(cid, access, opts))
      if (!queue.includes(other)) queue.push(other);
  }
}

/** True when `el` is a pointy element (used by callers that place instances). */
export { isPointy };
