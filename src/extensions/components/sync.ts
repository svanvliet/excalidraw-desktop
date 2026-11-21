/**
 * Components v1 sync: makes every instance of one component match its master. Used by the
 * reactor rule (live, `CaptureUpdateAction.NEVER`) and by the draft-level actions (so their
 * single undo step already contains a consistent scene). Pure over a small access interface.
 *
 * Per component:
 *  1. Elements whose component group is gone (ungrouped) lose their tag (detached).
 *  2. No live master → the instance with the smallest group id is promoted (keeps its look).
 *     Several live masters (undo of a delete, collab) → the non-promoted one with the smallest
 *     group id wins; others are demoted back to instances (restoring their old overrides).
 *  3. Untagged elements drawn/pasted into the master group are adopted as new master children.
 *  4. Every live instance gets one child per live master slot (created with a deterministic id
 *     or undeleted) and loses children whose slot is gone. Children are derived from the master
 *     under the instance's inferred transform, with its per-slot overrides applied. Direct edits
 *     to overridable keys become overrides; any other direct edit is reverted.
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
  hasAnyTag,
  OVERRIDE_KEYS,
  stableId,
  tagOf,
  withTag,
  type Base,
  type ComponentTag,
  type OverrideKey,
  type Overrides,
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
  return key === "text" ? (m as TextEl).originalText : rec(m)[key];
}

function currentValue(c: El, key: OverrideKey): unknown {
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

/** Pick the instance's transform from its children, preferring ones the user didn't touch. */
function chooseTransform(children: readonly El[], changed: ReadonlySet<string>): Transform {
  const cands = children.filter((c) => !c.isDeleted && !isBoundText(c) && tagOf(c)?.base);
  if (!cands.length) return translation(originOf(children.filter((c) => !c.isDeleted)));
  const area = (c: El) => {
    const b = tagOf(c)!.base!;
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
  return inferTransform(ref, tagOf(ref)!.base!);
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
}

interface MasterCtx {
  componentId: string;
  name?: string;
  bySlot: Map<string, El>;
  slotOfId: Map<string, string>;
  bases: Map<string, Base>;
  /** Slots in processing order: containers before their bound text. */
  order: string[];
}

/** Everything about `m`'s instance copy except geometry of bound text. */
function deriveChild(
  m: El,
  c: El | undefined,
  overrides: Overrides | undefined,
  mc: MasterCtx,
  ic: InstanceCtx,
  access: SyncAccess,
): Patch {
  const slot = mc.slotOfId.get(m.id)!;
  const base = mc.bases.get(slot)!;
  const mr = rec(m);
  const ov = cleanOverrides(m, overrides);
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
    return s ? ic.idOf.get(s) : undefined;
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
    const containerId = internalId(mt.containerId) ?? null;
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

  const tag: ComponentTag = {
    v: 1,
    role: "instance",
    componentId: mc.componentId,
    slot,
    gi: (c && tagOf(c)?.gi) ?? tagOf(m)?.gi ?? 0,
    base,
  };
  if (mc.name) tag.name = mc.name;
  if (ov) tag.overrides = ov;
  p.customData = withTag(c ?? m, tag);
  return withoutUndefined(p);
}

/** A new instance child for `m` (id deterministic from instance group + slot). */
function newChild(m: El, id: string, ic: InstanceCtx): El {
  const tag = tagOf(m);
  const inner = m.groupIds.slice(0, tag?.gi ?? 0).map((g) => {
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
    const tag = tagOf(el);
    if (tag?.componentId === componentId && tag.role === "master" && !el.isDeleted) {
      const g = groupOf(el, tag);
      if (g) masterGroups.add(g);
    }
  }
  return elements.filter((el) => {
    const tag = tagOf(el);
    if (tag) return tag.componentId === componentId;
    return !hasAnyTag(el) && el.groupIds.some((g) => masterGroups.has(g));
  });
}

export function syncComponent(
  componentId: string,
  access: SyncAccess,
  opts: SyncOptions = {},
): void {
  const changed = opts.changed ?? EMPTY;
  const masters = new Map<string, El[]>();
  const instances = new Map<string, El[]>();
  const untagged: El[] = [];
  const latest = (el: El) => access.get(el.id) ?? el;

  for (const el of access.members(componentId)) {
    const tag = tagOf(el);
    if (!tag) {
      if (!hasAnyTag(el) && !el.isDeleted) untagged.push(el);
      continue;
    }
    if (tag.componentId !== componentId) continue;
    const g = groupOf(el, tag);
    if (!g) {
      // Ungrouped out of its component: it's an ordinary element now.
      if (!el.isDeleted) access.patch(el.id, { customData: withTag(el, null) });
      continue;
    }
    push(tag.role === "master" ? masters : instances, g, el);
  }
  const isLive = (els: readonly El[]) => els.some((e) => !e.isDeleted);

  // --- 2. one live master ---------------------------------------------------------------------
  let liveMasters = [...masters].filter(([, els]) => isLive(els)).map(([g]) => g);
  if (!liveMasters.length) {
    const cands = [...instances].filter(([, els]) => isLive(els)).map(([g]) => g);
    if (!cands.length) return;
    cands.sort(byId);
    const g = cands[0];
    const els = instances.get(g)!;
    for (const el of els) {
      const tag = tagOf(el)!;
      access.patch(el.id, {
        customData: withTag(el, {
          ...tag,
          role: "master",
          base: undefined,
          overrides: undefined,
          promoted: { overrides: tag.overrides ?? {}, ...(tag.base ? { base: tag.base } : {}) },
        } as ComponentTag),
      });
    }
    instances.delete(g);
    masters.set(g, els.map(latest));
    liveMasters = [g];
  }
  const isPromoted = (g: string) => masters.get(g)!.some((e) => !!tagOf(latest(e))?.promoted);
  liveMasters.sort((a, b) => Number(isPromoted(a)) - Number(isPromoted(b)) || byId(a, b));
  const masterGroup = liveMasters[0];
  for (const g of liveMasters.slice(1)) {
    const els = masters.get(g)!.map(latest);
    const origin = originOf(els.filter((e) => !e.isDeleted));
    for (const el of els) {
      const tag = tagOf(el)!;
      const promoted = tag.promoted as { overrides?: Overrides; base?: Base } | undefined;
      access.patch(el.id, {
        customData: withTag(el, {
          ...tag,
          role: "instance",
          promoted: undefined,
          base: promoted?.base ?? baseOf(el, origin),
          overrides: promoted?.overrides,
        }),
      });
    }
    masters.delete(g);
    instances.set(g, els.map(latest));
  }

  // --- 3. master children (adopt + dedupe slots) ---------------------------------------------
  const masterEls = masters.get(masterGroup)!.map(latest);
  const name = masterEls.map((e) => tagOf(e)?.name).find(Boolean);
  for (const el of untagged) {
    const gi = el.groupIds.indexOf(masterGroup);
    if (gi < 0) continue;
    const tag: ComponentTag = { v: 1, role: "master", componentId, slot: el.id, gi };
    if (name) tag.name = name;
    access.patch(el.id, { customData: withTag(el, tag) });
    masterEls.push(latest(el));
  }
  const mc: MasterCtx = {
    componentId,
    name,
    bySlot: new Map(),
    slotOfId: new Map(),
    bases: new Map(),
    order: [],
  };
  const liveMaster = masterEls.filter((e) => !e.isDeleted);
  liveMaster.sort((a, b) => byId(a.id, b.id));
  for (const el of liveMaster) {
    let slot = tagOf(el)!.slot;
    if (mc.bySlot.has(slot)) {
      slot = el.id;
      access.patch(el.id, { customData: withTag(el, { ...tagOf(el)!, slot }) });
    }
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
    const bySlot = new Map<string, El>();
    for (const c of [...children].sort((a, b) => Number(a.isDeleted) - Number(b.isDeleted))) {
      const slot = tagOf(c)!.slot;
      if (!bySlot.has(slot)) bySlot.set(slot, c);
      else if (!c.isDeleted) access.patch(c.id, { customData: withTag(c, null) });
    }
    const anyLive = children.find((c) => !c.isDeleted)!;
    const anyTag = tagOf(anyLive)!;
    const ic: InstanceCtx = {
      group,
      t: chooseTransform(children, changed),
      idOf: new Map(),
      ids: new Set(children.map((c) => c.id)),
      innerMap: new Map(),
      outer: anyLive.groupIds.slice(anyTag.gi + 1),
      frameId: anyLive.frameId,
    };
    for (const slot of mc.order) {
      const id = bySlot.get(slot)?.id ?? stableId(group, slot);
      ic.idOf.set(slot, id);
      ic.ids.add(id);
      const c = bySlot.get(slot);
      const m = mc.bySlot.get(slot)!;
      const mt = tagOf(m);
      const ct = c && tagOf(c);
      if (c && mt && ct) {
        for (let i = 0; i < Math.min(mt.gi, ct.gi); i++)
          if (!ic.innerMap.has(m.groupIds[i])) ic.innerMap.set(m.groupIds[i], c.groupIds[i]);
      }
    }

    let last = children[children.length - 1].id;
    for (const slot of mc.order) {
      const m = mc.bySlot.get(slot)!;
      let c = bySlot.get(slot);
      const id = ic.idOf.get(slot)!;
      if (!c) {
        const existing = access.get(id);
        if (existing && tagOf(existing)?.componentId === componentId) c = existing;
      }
      let overrides = c ? { ...(tagOf(c)?.overrides ?? {}) } : undefined;
      if (c && !c.isDeleted && changed.has(c.id)) overrides = adopt(m, c, overrides!, opts.memory);
      const patch = deriveChild(m, c, overrides, mc, ic, access);
      if (!c) {
        access.add(newElementWith(newChild(m, id, ic), patch as never, true), last);
      } else {
        access.patch(c.id, { ...patch, isDeleted: false });
      }
      last = id;
    }
    for (const [slot, c] of bySlot) {
      if (!mc.bySlot.has(slot) && !c.isDeleted) access.patch(c.id, { isDeleted: true });
    }
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
}

/** Direct edits to overridable keys of an instance child become overrides. */
function adopt(
  m: El,
  c: El,
  overrides: Overrides,
  memory: Map<string, Record<string, unknown>> | undefined,
): Overrides {
  const out = { ...overrides };
  const prev = memory?.get(c.id);
  for (const k of OVERRIDE_KEYS) {
    if (!overridable(m, k) || (k === "text" && c.type !== "text")) continue;
    const cur = currentValue(c, k);
    if (prev && same(cur, prev[k])) continue;
    const expected = k in out ? out[k] : masterValue(m, k);
    if (same(cur, expected)) continue;
    if (same(cur, masterValue(m, k))) delete out[k];
    else out[k] = cur;
  }
  return out;
}

/** True when `el` is a pointy element (used by callers that place instances). */
export { isPointy };
