/**
 * Smart container layout (docs/containers.md). `computeStack` is the pure maths; `reflow` applies
 * it to one container through a `LayoutAccess` (a Draft for commands and agent tools, the
 * reactor's reconcile context for live edits) and then re-flows the enclosing containers.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { boundsOf } from "../../agent/scene/draft";
import { boxOf, readDef, unitsOf, type ContainerDef } from "./model";

type El = ExcalidrawElement;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StackUnit {
  key: string;
  rect: Rect;
  /** Scene order (tie-break when two units share a main-axis centre). */
  z: number;
}

export interface StackResult {
  box: Rect;
  /** Top-left each unit should move to, by key. */
  at: Map<string, { x: number; y: number }>;
  /** Unit keys in layout order. */
  order: string[];
}

const EPS = 1e-6;
export const near = (a: number, b: number) => Math.abs(a - b) < EPS;

/** Unit keys in layout order: by main-axis centre, then z-order. */
export function stackOrder(def: Pick<ContainerDef, "direction">, units: readonly StackUnit[]) {
  const v = def.direction === "vertical";
  const mid = (r: Rect) => (v ? r.y + r.h / 2 : r.x + r.w / 2);
  return [...units].sort((a, b) => mid(a.rect) - mid(b.rect) || a.z - b.z);
}

/** Where every unit goes and how big the box is. The box's top-left is the anchor. */
export function computeStack(
  def: Omit<ContainerDef, "gi">,
  box: Rect,
  units: readonly StackUnit[],
): StackResult {
  const v = def.direction === "vertical";
  const ordered = stackOrder(def, units);
  const pad = def.padding;
  const [padMainA, padMainB] = v ? [pad.top, pad.bottom] : [pad.left, pad.right];
  const [padCrossA, padCrossB] = v ? [pad.left, pad.right] : [pad.top, pad.bottom];
  const mainOf = (r: Rect) => (v ? r.h : r.w);
  const crossOf = (r: Rect) => (v ? r.w : r.h);
  const mainSizing = v ? def.sizing.h : def.sizing.w;
  const crossSizing = v ? def.sizing.w : def.sizing.h;

  const n = ordered.length;
  const content = ordered.reduce((s, u) => s + mainOf(u.rect), 0) + def.gap * Math.max(0, n - 1);
  const maxCross = ordered.reduce((m, u) => Math.max(m, crossOf(u.rect)), 0);
  const mainLen =
    mainSizing === "hug" ? Math.max(1, padMainA + content + padMainB) : v ? box.h : box.w;
  const crossLen =
    crossSizing === "hug" ? Math.max(1, padCrossA + maxCross + padCrossB) : v ? box.w : box.h;

  const free = mainLen - padMainA - padMainB - content;
  let offset = 0;
  let gap = def.gap;
  if (mainSizing === "fixed") {
    if (def.justify === "center") offset = free / 2;
    else if (def.justify === "end") offset = free;
    else if (def.justify === "space-between" && n > 1 && free > 0) gap += free / (n - 1);
  }

  const innerCross = crossLen - padCrossA - padCrossB;
  const mainStart = (v ? box.y : box.x) + padMainA + offset;
  const crossStart = (v ? box.x : box.y) + padCrossA;
  const at = new Map<string, { x: number; y: number }>();
  let cursor = mainStart;
  for (const u of ordered) {
    const size = crossOf(u.rect);
    const c =
      def.align === "center"
        ? crossStart + (innerCross - size) / 2
        : def.align === "end"
          ? crossStart + innerCross - size
          : crossStart;
    at.set(u.key, v ? { x: c, y: cursor } : { x: cursor, y: c });
    cursor += mainOf(u.rect) + gap;
  }
  return {
    box: { x: box.x, y: box.y, w: v ? crossLen : mainLen, h: v ? mainLen : crossLen },
    at,
    order: ordered.map((u) => u.key),
  };
}

export interface LayoutAccess {
  get(id: string): El | undefined;
  /** Elements carrying `group` (deleted ones may be included), in scene order. */
  members(group: string): El[];
  patch(id: string, patch: Record<string, unknown>): void;
  /** Elements being dragged/resized right now: their units keep their place until it ends. */
  held?(id: string): boolean;
}

export function rectOf(els: readonly El[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of els) {
    const b = boundsOf(el);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return Number.isFinite(minX)
    ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    : { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * Lay out container `group` (no-op unless it has an active box), then each enclosing container.
 * Returns the ids it patched.
 */
export function reflow(access: LayoutAccess, group: string, out = new Set<string>()): Set<string> {
  const members = access.members(group);
  const box = boxOf(members, group);
  if (!box) return out;
  const def = readDef(box)!;
  const units = unitsOf(members, group, box.id).map((u) => {
    const els = u.ids.map((id) => access.get(id)).filter((e): e is El => !!e);
    return { ...u, els, rect: rectOf(els), held: u.ids.some((id) => access.held?.(id)) };
  });
  const res = computeStack(def, { x: box.x, y: box.y, w: box.width, h: box.height }, units);
  for (const u of units) {
    if (u.held) continue;
    const to = res.at.get(u.key)!;
    const dx = to.x - u.rect.x;
    const dy = to.y - u.rect.y;
    if (near(dx, 0) && near(dy, 0)) continue;
    for (const el of u.els) {
      access.patch(el.id, { x: el.x + dx, y: el.y + dy });
      out.add(el.id);
    }
  }
  if (!access.held?.(box.id) && (!near(res.box.w, box.width) || !near(res.box.h, box.height))) {
    access.patch(box.id, { width: res.box.w, height: res.box.h });
    out.add(box.id);
  }
  for (const g of box.groupIds.slice(def.gi + 1)) {
    if (boxOf(access.members(g), g)) {
      reflow(access, g, out);
      break;
    }
  }
  return out;
}

/** Active container groups `el` is in, innermost first (by its `groupIds` order). */
export function containerGroupsOf(access: LayoutAccess, el: El): string[] {
  return el.groupIds.filter((g) => !!boxOf(access.members(g), g));
}

/** Re-flow every container holding any of `ids` (innermost first). */
export function reflowAround(access: LayoutAccess, ids: Iterable<string>): Set<string> {
  const groups: Array<{ g: string; depth: number }> = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const el = access.get(id);
    if (!el) continue;
    el.groupIds.forEach((g, i) => {
      if (seen.has(g)) return;
      seen.add(g);
      groups.push({ g, depth: el.groupIds.length - i });
    });
  }
  groups.sort((a, b) => b.depth - a.depth);
  const out = new Set<string>();
  for (const { g } of groups) reflow(access, g, out);
  return out;
}
