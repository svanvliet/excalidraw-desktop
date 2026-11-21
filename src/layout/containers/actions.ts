/**
 * Smart container operations on a `Draft` (docs/containers.md). The panel, shortcut and agent
 * tools all go through these, and each one re-flows inside the same draft so the whole action is
 * one undo step (the live reactor then has nothing left to write).
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { Draft, ToolError, newId, type El } from "../../agent/scene/draft";
import { reflowDraft, snapshot } from "./draftAccess";
import {
  ALIGNS,
  COMPONENT_NS,
  DEFAULT_DEF,
  DIRECTIONS,
  JUSTIFIES,
  LAYOUT_NS,
  MAX_SPACING,
  SIZINGS,
  boxOf,
  containerGroupOf,
  isActiveBox,
  isInstanceCopy,
  okSpacing,
  readDef,
  unitsOf,
  withDef,
  type Align,
  type ContainerDef,
  type Direction,
  type Justify,
  type Padding,
  type Sizing,
  type Unit,
} from "./model";
import { computeStack, near, rectOf, stackOrder } from "./stack";

export interface ContainerRef {
  group: string;
  box: El;
  def: ContainerDef;
}

export interface ContainerChanges {
  direction?: Direction;
  gap?: number;
  /** One number for all sides, or any subset of sides. */
  padding?: number | Partial<Padding>;
  align?: Align;
  justify?: Justify;
  sizing?: Partial<{ w: Sizing; h: Sizing }>;
  /** Fixed width / height (switches that axis to `fixed`). */
  width?: number;
  height?: number;
}

type Tagged = { gi?: unknown; role?: unknown };

const live = (draft: Draft) => draft.live();

function members(draft: Draft, group: string): El[] {
  return draft.toArray().filter((e) => e.groupIds.includes(group));
}

function compTag(el: El): Tagged | undefined {
  return (el.customData as Record<string, Tagged> | undefined)?.[COMPONENT_NS];
}

/**
 * `customData` with every tag `gi` (component and container) at/after `from` shifted by `by`, or
 * undefined if none moved. Needed whenever a group is inserted into or removed from `groupIds`.
 */
function shiftTags(el: El, from: number, by: 1 | -1): Record<string, unknown> | undefined {
  const cd = el.customData as Record<string, Tagged & Record<string, unknown>> | undefined;
  if (!cd) return undefined;
  let next: Record<string, unknown> | undefined;
  const comp = cd[COMPONENT_NS];
  if (comp && typeof comp.gi === "number" && comp.gi >= from) {
    next = { ...cd, [COMPONENT_NS]: { ...comp, gi: comp.gi + by } };
  }
  const def = readDef(el);
  if (def && def.gi >= from) {
    next = withDef({ ...el, customData: next ?? cd } as El, { ...def, gi: def.gi + by });
  }
  return next;
}

/** Ids plus their bound text; a bound text stands for its container. */
function expand(draft: Draft, ids: readonly unknown[]): El[] {
  const out = new Map<string, El>();
  for (const id of ids) {
    const el = draft.mustGet(id);
    const cid = el.type === "text" ? (el as { containerId?: string | null }).containerId : null;
    const owner = cid ? draft.get(cid) : undefined;
    for (const e of owner ? [owner] : [el]) {
      out.set(e.id, e);
      const text = draft.boundTextOf(e);
      if (text) out.set(text.id, text);
    }
  }
  return [...out.values()];
}

/**
 * Where a new group goes in each element's `groupIds`: just inside the first group that reaches
 * outside the selection. Inner groups (a user group, a nested container, a component instance)
 * stay whole and become one layout unit.
 */
function insertionPoints(draft: Draft, els: readonly El[], what: string) {
  const selected = new Set(els.map((e) => e.id));
  const memberIds = new Map<string, string[]>();
  for (const el of live(draft))
    for (const g of el.groupIds) {
      const l = memberIds.get(g);
      if (l) l.push(el.id);
      else memberIds.set(g, [el.id]);
    }
  const inside = (g: string) => (memberIds.get(g) ?? []).every((id) => selected.has(id));
  const at = new Map<string, number>();
  for (const el of els) {
    const i = el.groupIds.findIndex((g) => !inside(g));
    const idx = i < 0 ? el.groupIds.length : i;
    at.set(el.id, idx);
    const comp = compTag(el);
    if (isInstanceCopy(el) && typeof comp?.gi === "number" && idx <= comp.gi) {
      throw new ToolError(
        `Element "${el.id}" is inside a component instance; select the whole instance (or edit its master) to ${what}`,
      );
    }
  }
  return { at, inside };
}

function newBox(rect: { x: number; y: number; w: number; h: number }): El {
  const [el] = convertToExcalidrawElements(
    [
      {
        type: "rectangle",
        x: rect.x,
        y: rect.y,
        width: Math.max(1, rect.w),
        height: Math.max(1, rect.h),
        strokeColor: "#868e96",
        backgroundColor: "transparent",
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      } as ExcalidrawElementSkeleton,
    ],
    { regenerateIds: true },
  );
  return el;
}

// --- validation ------------------------------------------------------------------------------

function oneOf<T extends string>(v: unknown, list: readonly T[], name: string): T {
  if (!list.includes(v as T)) throw new ToolError(`${name} must be one of ${list.join(", ")}`);
  return v as T;
}

function spacing(v: unknown, name: string): number {
  if (!okSpacing(v)) throw new ToolError(`${name} must be a number from 0 to ${MAX_SPACING}`);
  return v;
}

function size(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 100_000) {
    throw new ToolError(`${name} must be a number from 1 to 100000`);
  }
  return v;
}

/** `base` with `changes` applied (validated). */
export function mergeDef(base: Omit<ContainerDef, "gi">, changes: ContainerChanges = {}) {
  const c = (changes ?? {}) as Record<string, unknown>;
  const def = {
    ...base,
    padding: { ...base.padding },
    sizing: { ...base.sizing },
  };
  if (c.direction !== undefined) def.direction = oneOf(c.direction, DIRECTIONS, "direction");
  if (c.gap !== undefined) def.gap = spacing(c.gap, "gap");
  if (c.padding !== undefined) {
    if (typeof c.padding === "number") {
      const p = spacing(c.padding, "padding");
      def.padding = { top: p, right: p, bottom: p, left: p };
    } else if (c.padding && typeof c.padding === "object") {
      for (const [k, v] of Object.entries(c.padding)) {
        if (!(k in def.padding)) throw new ToolError(`padding has no side "${k}"`);
        def.padding[k as keyof Padding] = spacing(v, `padding.${k}`);
      }
    } else throw new ToolError("padding must be a number or {top,right,bottom,left}");
  }
  if (c.align !== undefined) def.align = oneOf(c.align, ALIGNS, "align");
  if (c.justify !== undefined) def.justify = oneOf(c.justify, JUSTIFIES, "justify");
  if (c.sizing !== undefined) {
    if (!c.sizing || typeof c.sizing !== "object") throw new ToolError("sizing must be {w?, h?}");
    for (const [k, v] of Object.entries(c.sizing)) {
      if (k !== "w" && k !== "h") throw new ToolError(`sizing has no axis "${k}"`);
      def.sizing[k] = oneOf(v, SIZINGS, `sizing.${k}`);
    }
  }
  if (c.width !== undefined) {
    size(c.width, "width");
    def.sizing.w = "fixed";
  }
  if (c.height !== undefined) {
    size(c.height, "height");
    def.sizing.h = "fixed";
  }
  return def;
}

// --- lookup ----------------------------------------------------------------------------------

/** The innermost container that `el` is the box of or a member of (at any depth). */
export function containerOfEl(draft: Draft, el: El): ContainerRef | null {
  if (isActiveBox(el)) return { group: containerGroupOf(el)!, box: el, def: readDef(el)! };
  for (const g of el.groupIds) {
    const box = boxOf(members(draft, g), g);
    if (box) return { group: g, box, def: readDef(box)! };
  }
  return null;
}

/** The container enclosing container box `box`, if any. */
export function parentOf(draft: Draft, box: El): ContainerRef | null {
  const def = readDef(box);
  for (const g of box.groupIds.slice((def?.gi ?? -1) + 1)) {
    const b = boxOf(members(draft, g), g);
    if (b) return { group: g, box: b, def: readDef(b)! };
  }
  return null;
}

/** A container by its box id, any member's id (innermost container), or its group id. */
export function resolveContainer(draft: Draft, ref: unknown): ContainerRef {
  if (typeof ref !== "string" || !ref) {
    throw new ToolError("containerId must be a container's box id (or a group id)");
  }
  const el = draft.get(ref);
  const hit = el ? containerOfEl(draft, el) : null;
  if (hit) return hit;
  const box = boxOf(members(draft, ref), ref);
  if (box) return { group: ref, box, def: readDef(box)! };
  throw new ToolError(`"${ref}" is not a smart container (or inside one)`);
}

function unitsWithRects(draft: Draft, c: ContainerRef) {
  return unitsOf(members(draft, c.group), c.group, c.box.id).map((u) => ({
    ...u,
    rect: rectOf(u.ids.map((id) => draft.peek(id)!).filter((e) => !e.isDeleted)),
  }));
}

/** Children of a container in layout order. */
export function childUnits(draft: Draft, c: ContainerRef): Unit[] {
  const units = unitsWithRects(draft, c);
  return stackOrder(c.def, units);
}

function boxRect(box: El) {
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

/** Lay `c` out with units in exactly `keys` order (then re-flow enclosing containers). */
function placeInOrder(draft: Draft, c: ContainerRef, keys: readonly string[]) {
  const box = draft.get(c.box.id)!;
  const def = readDef(box)!;
  const byKey = new Map(unitsWithRects(draft, { ...c, box, def }).map((u) => [u.key, u]));
  const ordered = keys.map((k) => byKey.get(k)!).filter(Boolean);
  const res = computeStack(def, boxRect(box), ordered, { keepOrder: true });
  for (const u of ordered) {
    const to = res.at.get(u.key)!;
    const dx = to.x - u.rect.x;
    const dy = to.y - u.rect.y;
    if (near(dx, 0) && near(dy, 0)) continue;
    for (const id of u.ids) {
      const el = draft.peek(id)!;
      draft.update(id, { x: el.x + dx, y: el.y + dy });
    }
  }
  if (!near(res.box.w, box.width) || !near(res.box.h, box.height)) {
    draft.update(box.id, { width: res.box.w, height: res.box.h });
  }
}

/** Unit key of each id (any element of a unit names the unit). */
function unitKeys(draft: Draft, c: ContainerRef, ids: readonly unknown[]): string[] {
  const keyOf = new Map<string, string>();
  for (const u of unitsWithRects(draft, c)) {
    keyOf.set(u.key, u.key);
    for (const id of u.ids) keyOf.set(id, u.key);
  }
  const out: string[] = [];
  for (const id of ids) {
    const key = typeof id === "string" ? keyOf.get(id) : undefined;
    if (!key) throw new ToolError(`"${String(id)}" is not a child of container "${c.box.id}"`);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

// --- operations ------------------------------------------------------------------------------

export interface MadeContainer {
  containerId: string;
  groupId: string;
  childIds: string[];
}

/** Wrap `ids` in a new container (a group plus a tagged background box sized to fit). */
export function makeContainer(
  draft: Draft,
  ids: readonly unknown[],
  changes: ContainerChanges = {},
): MadeContainer {
  if (!Array.isArray(ids) || !ids.length) {
    throw new ToolError("Select at least one element to make a container");
  }
  const before = snapshot(draft);
  const els = expand(draft, ids);
  const frameId = els[0].frameId;
  if (els.some((e) => e.frameId !== frameId)) {
    throw new ToolError("A container's elements must all be in the same frame (or none)");
  }
  const { at } = insertionPoints(draft, els, "make a container");
  const outerOf = (el: El) => el.groupIds.slice(at.get(el.id)!);
  const outer = outerOf(els[0]);
  if (els.some((e) => outerOf(e).join() !== outer.join())) {
    throw new ToolError("The elements are in different groups; select elements of one group");
  }

  const def = { ...mergeDef(DEFAULT_DEF, changes), gi: 0 };
  const group = newId();
  for (const el of els) {
    const i = at.get(el.id)!;
    const customData = shiftTags(el, i, 1);
    draft.update(el.id, {
      groupIds: [...el.groupIds.slice(0, i), group, ...el.groupIds.slice(i)],
      ...(customData ? { customData } : {}),
    });
  }

  const r = rectOf(els);
  const p = def.padding;
  const seed = newBox({
    x: r.x - p.left,
    y: r.y - p.top,
    w: changes.width ?? r.w + p.left + p.right,
    h: changes.height ?? r.h + p.top + p.bottom,
  });
  const box = {
    ...seed,
    groupIds: [group, ...outer],
    frameId,
    customData: withDef({ ...seed, customData: {} } as El, def),
  } as El;
  // Directly below the lowest selected element, so the children paint on top of the box.
  const order = draft.toArray();
  const selected = new Set(els.map((e) => e.id));
  const lowest = order.findIndex((e) => selected.has(e.id));
  if (lowest > 0) draft.add(box, order[lowest - 1].id);
  else {
    draft.add(box);
    draft.reorder(new Set([box.id]), "back");
  }
  reflowDraft(draft, [box.id], before);
  return { containerId: box.id, groupId: group, childIds: els.map((e) => e.id) };
}

/** Change a container's settings and/or the order of its children. */
export function updateContainer(
  draft: Draft,
  ref: unknown,
  changes: ContainerChanges & { order?: readonly unknown[] } = {},
): ContainerRef {
  const before = snapshot(draft);
  const c = resolveContainer(draft, ref);
  const next = { ...mergeDef(c.def, changes), gi: c.def.gi };
  // Keep the current order across a direction switch (positions would scramble it).
  const keys =
    changes.order !== undefined
      ? unitKeys(draft, c, Array.isArray(changes.order) ? changes.order : [changes.order])
      : next.direction !== c.def.direction
        ? childUnits(draft, c).map((u) => u.key)
        : null;
  if (keys) {
    const all = childUnits(draft, c).map((u) => u.key);
    if (changes.order !== undefined && keys.length !== all.length) {
      throw new ToolError(
        `order must list every child of the container once (${all.length} children: ${all.join(", ")})`,
      );
    }
  }
  draft.update(c.box.id, {
    customData: withDef(c.box, next),
    ...(changes.width !== undefined ? { width: changes.width } : {}),
    ...(changes.height !== undefined ? { height: changes.height } : {}),
  });
  const updated = { ...c, box: draft.get(c.box.id)!, def: next };
  if (keys) placeInOrder(draft, updated, keys);
  reflowDraft(draft, [c.box.id], before);
  return { ...updated, box: draft.get(c.box.id)! };
}

/**
 * Move one child (by any of its ids) to `index` in its container's order. The container is the
 * innermost one holding `id` (for a nested container's box, the one around it) unless given.
 */
export function moveChild(draft: Draft, id: unknown, index: number, container?: unknown): void {
  const el = draft.mustGet(id);
  const c =
    container !== undefined
      ? resolveContainer(draft, container)
      : isActiveBox(el)
        ? parentOf(draft, el)
        : containerOfEl(draft, el);
  if (!c || c.box.id === el.id) throw new ToolError(`"${String(id)}" is not in a container`);
  const before = snapshot(draft);
  const [key] = unitKeys(draft, c, [el.id]);
  const keys = childUnits(draft, c)
    .map((u) => u.key)
    .filter((k) => k !== key);
  keys.splice(Math.max(0, Math.min(keys.length, Math.round(index))), 0, key);
  placeInOrder(draft, c, keys);
  reflowDraft(draft, [c.box.id], before);
}

/**
 * Stop a container. By default the box is deleted and the group dissolved (children stay where
 * they are); `keepBox` only clears the layout tag, leaving a plain group with its rectangle.
 */
export function removeContainer(
  draft: Draft,
  ref: unknown,
  opts: { keepBox?: boolean } = {},
): void {
  const before = snapshot(draft);
  const c = resolveContainer(draft, ref);
  if (opts.keepBox) {
    draft.update(c.box.id, { customData: withDef(c.box, null) });
    return;
  }
  for (const id of [c.box.id, draft.boundTextOf(c.box)?.id]) {
    if (id) draft.update(id, { isDeleted: true });
  }
  for (const a of draft.arrowsBoundTo(c.box.id)) {
    draft.update(a.id, {
      ...(a.startBinding?.elementId === c.box.id ? { startBinding: null } : {}),
      ...(a.endBinding?.elementId === c.box.id ? { endBinding: null } : {}),
    });
  }
  const rest: string[] = [];
  for (const el of members(draft, c.group)) {
    if (el.isDeleted) continue;
    const i = el.groupIds.indexOf(c.group);
    const customData = shiftTags(el, i + 1, -1);
    draft.update(el.id, {
      groupIds: el.groupIds.filter((g) => g !== c.group),
      ...(customData ? { customData } : {}),
    });
    rest.push(el.id);
  }
  reflowDraft(draft, rest, before);
}

/** Put `ids` (whole groups / instances stay whole) into a container, at `index` (default end). */
export function addToContainer(
  draft: Draft,
  ref: unknown,
  ids: readonly unknown[],
  index?: number,
): string[] {
  if (!Array.isArray(ids) || !ids.length) throw new ToolError("ids must list at least one element");
  const before = snapshot(draft);
  const c = resolveContainer(draft, ref);
  const els = expand(draft, ids);
  const { at } = insertionPoints(draft, els, "add it to a container");
  const outer = c.box.groupIds.slice(c.def.gi + 1);
  const ancestors = new Set(c.box.groupIds);
  const keys: string[] = [];
  const left = new Set<string>();
  for (const el of els) {
    const i = at.get(el.id)!;
    if (el.id === c.box.id || el.groupIds.slice(0, i).some((g) => ancestors.has(g))) {
      throw new ToolError(`Can't put "${el.id}" into a container inside it`);
    }
    if (el.groupIds.includes(c.group)) {
      throw new ToolError(`"${el.id}" is already in container "${c.box.id}"`);
    }
    const comp = compTag(el);
    if (typeof comp?.gi === "number" && comp.gi >= i) {
      throw new ToolError(`"${el.id}" is part of a component; select the whole component`);
    }
    const own = readDef(el);
    if (own && own.gi >= i) {
      throw new ToolError(`"${el.id}" is a container's box; select the whole container`);
    }
    for (const g of el.groupIds.slice(i)) for (const m of members(draft, g)) left.add(m.id);
    const key = i === 0 ? el.id : el.groupIds[i - 1];
    if (!keys.includes(key)) keys.push(key);
  }
  const current = childUnits(draft, c).map((u) => u.key);
  for (const el of els) {
    const i = at.get(el.id)!;
    draft.update(el.id, {
      groupIds: [...el.groupIds.slice(0, i), c.group, ...outer],
      frameId: c.box.frameId,
    });
    left.delete(el.id);
  }
  // Children paint above the box.
  const order = draft.toArray().map((e) => e.id);
  const boxAt = order.indexOf(c.box.id);
  const below = els.filter((e) => order.indexOf(e.id) < boxAt).map((e) => e.id);
  if (below.length) draft.reorder(new Set(below), "front");

  const pos =
    index === undefined || !Number.isFinite(index)
      ? current.length
      : Math.max(0, Math.min(current.length, Math.round(index)));
  current.splice(pos, 0, ...keys);
  placeInOrder(draft, c, current);
  reflowDraft(draft, [c.box.id, ...left], before);
  return keys;
}

/**
 * Take `ids` out of the container they are direct children of (whole groups / instances / nested
 * containers stay whole), one level up: they keep any enclosing container and are placed just
 * after the container they left.
 */
export function removeFromContainer(draft: Draft, ids: readonly unknown[]): string[] {
  if (!Array.isArray(ids) || !ids.length) throw new ToolError("ids must list at least one element");
  const before = snapshot(draft);
  const els = expand(draft, ids);
  const { at } = insertionPoints(draft, els, "take it out of its container");
  const byGroup = new Map<string, El[]>();
  for (const el of els) {
    const i = at.get(el.id)!;
    const own = readDef(el);
    if (own && isActiveBox(el) && own.gi >= i) {
      throw new ToolError(`"${el.id}" is a container's box; select the whole container`);
    }
    const g = el.groupIds[i];
    if (!g || !boxOf(members(draft, g), g)) {
      throw new ToolError(
        `"${el.id}" is not a direct child of a container (select its whole group inside it)`,
      );
    }
    const list = byGroup.get(g);
    if (list) list.push(el);
    else byGroup.set(g, [el]);
  }
  const touched = new Set<string>();
  for (const [g, list] of byGroup) {
    const c = resolveContainer(draft, g);
    for (const el of list) {
      const m = draft.get(el.id)!;
      const i = m.groupIds.indexOf(g);
      const customData = shiftTags(m, i + 1, -1);
      draft.update(m.id, {
        groupIds: m.groupIds.filter((x) => x !== g),
        ...(customData ? { customData } : {}),
      });
    }
    reflowDraft(draft, [c.box.id]);
    // Just after the container along the enclosing stack (or this one's) main axis.
    const box = draft.get(c.box.id)!;
    const parent = parentOf(draft, box);
    const def = parent?.def ?? c.def;
    const gap = Math.max(def.gap, 16);
    const r = rectOf(list.map((e) => draft.get(e.id)!));
    const [dx, dy] =
      def.direction === "horizontal"
        ? [box.x + box.width + gap - r.x, box.y - r.y]
        : [box.x - r.x, box.y + box.height + gap - r.y];
    for (const el of list) {
      const m = draft.get(el.id)!;
      draft.update(m.id, { x: m.x + dx, y: m.y + dy });
      touched.add(m.id);
    }
    touched.add(box.id);
  }
  reflowDraft(draft, touched, before);
  return els.map((e) => e.id);
}

/** Plain description of every active container (for the agent's read tools). */
export function describeContainers(draft: Draft) {
  const out: Array<Record<string, unknown>> = [];
  for (const box of live(draft)) {
    if (!isActiveBox(box)) continue;
    const def = readDef(box)!;
    const group = containerGroupOf(box, def)!;
    const c = { group, box, def };
    const parent = parentOf(draft, box);
    out.push({
      containerId: box.id,
      groupId: group,
      parentContainerId: parent?.box.id ?? null,
      direction: def.direction,
      gap: def.gap,
      padding: def.padding,
      align: def.align,
      justify: def.justify,
      sizing: def.sizing,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      children: childUnits(draft, c).map((u) => ({ key: u.key, ids: u.ids })),
    });
  }
  return out;
}

export { LAYOUT_NS };
