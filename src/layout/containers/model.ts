/**
 * Smart containers (docs/containers.md, plan D-DX13): a group whose background rectangle (the
 * "box") carries `customData["excalidrawDesktop.layout"].container`. The container's identity is
 * `box.groupIds[gi]`; its children are the other elements carrying that group.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

type El = ExcalidrawElement;

export const LAYOUT_NS = "excalidrawDesktop.layout";
export const COMPONENT_NS = "excalidrawDesktop.component";

export type Direction = "vertical" | "horizontal";
export type Align = "start" | "center" | "end";
export type Justify = "start" | "center" | "end" | "space-between";
export type Sizing = "hug" | "fixed";

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ContainerDef {
  direction: Direction;
  gap: number;
  padding: Padding;
  /** Cross axis. */
  align: Align;
  /** Main axis; only matters when that axis is fixed (a hugging axis has no slack). */
  justify: Justify;
  sizing: { w: Sizing; h: Sizing };
  /** Index of the container group in the box's `groupIds`. */
  gi: number;
}

export interface LayoutTag {
  v: 1;
  container: ContainerDef;
}

export const DEFAULT_DEF: Omit<ContainerDef, "gi"> = {
  direction: "vertical",
  gap: 16,
  padding: { top: 16, right: 16, bottom: 16, left: 16 },
  align: "start",
  justify: "start",
  sizing: { w: "hug", h: "hug" },
};

export const DIRECTIONS: readonly Direction[] = ["vertical", "horizontal"];
export const ALIGNS: readonly Align[] = ["start", "center", "end"];
export const JUSTIFIES: readonly Justify[] = ["start", "center", "end", "space-between"];
export const SIZINGS: readonly Sizing[] = ["hug", "fixed"];

export const MAX_SPACING = 10_000;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const okSpacing = (v: unknown): v is number => isNum(v) && v >= 0 && v <= MAX_SPACING;

/** The parsed container definition, or null if absent, malformed or from a newer version. */
export function readDef(el: El): ContainerDef | null {
  const raw = (el.customData as Record<string, unknown> | undefined)?.[LAYOUT_NS] as
    | { v?: unknown; container?: Record<string, unknown> }
    | undefined;
  if (!raw || raw.v !== 1 || !raw.container || typeof raw.container !== "object") return null;
  const c = raw.container;
  const p = c.padding as Record<string, unknown> | undefined;
  const s = c.sizing as Record<string, unknown> | undefined;
  if (
    !DIRECTIONS.includes(c.direction as Direction) ||
    !okSpacing(c.gap) ||
    !p ||
    !okSpacing(p.top) ||
    !okSpacing(p.right) ||
    !okSpacing(p.bottom) ||
    !okSpacing(p.left) ||
    !ALIGNS.includes(c.align as Align) ||
    !JUSTIFIES.includes(c.justify as Justify) ||
    !s ||
    !SIZINGS.includes(s.w as Sizing) ||
    !SIZINGS.includes(s.h as Sizing) ||
    !Number.isInteger(c.gi) ||
    (c.gi as number) < 0
  ) {
    return null;
  }
  return {
    direction: c.direction as Direction,
    gap: c.gap as number,
    padding: { top: p.top, right: p.right, bottom: p.bottom, left: p.left } as Padding,
    align: c.align as Align,
    justify: c.justify as Justify,
    sizing: { w: s.w as Sizing, h: s.h as Sizing },
    gi: c.gi as number,
  };
}

export function hasLayoutTag(el: El): boolean {
  return !!(el.customData as Record<string, unknown> | undefined)?.[LAYOUT_NS];
}

/** `customData` for `el` with the container tag set (or removed when `def` is null). */
export function withDef(el: El, def: ContainerDef | null): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(el.customData ?? {}) };
  if (def) {
    const tag: LayoutTag = {
      v: 1,
      container: {
        direction: def.direction,
        gap: def.gap,
        padding: { ...def.padding },
        align: def.align,
        justify: def.justify,
        sizing: { ...def.sizing },
        gi: def.gi,
      },
    };
    next[LAYOUT_NS] = tag;
  } else delete next[LAYOUT_NS];
  return next;
}

/** The group a box's tag names, if the box is a usable container box. */
export function containerGroupOf(box: El, def = readDef(box)): string | null {
  if (!def || box.type !== "rectangle") return null;
  return box.groupIds[def.gi] ?? null;
}

export function isInstanceCopy(el: El): boolean {
  const comp = (el.customData as Record<string, unknown> | undefined)?.[COMPONENT_NS] as
    | { role?: unknown }
    | undefined;
  return comp?.role === "instance";
}

/**
 * Whether `box` is an *active* container: live, a rectangle with a valid tag naming one of its
 * groups, unrotated (v1), and not a component instance's copy (instances follow their master's
 * geometry through component sync, so laying them out here would fight it).
 */
export function isActiveBox(box: El): boolean {
  if (box.isDeleted || box.angle) return false;
  if (!containerGroupOf(box)) return false;
  return !isInstanceCopy(box);
}

/** The active box of `group` among `members` (elements carrying the group). */
export function boxOf(members: readonly El[], group: string): El | null {
  for (const el of members) {
    if (!el.isDeleted && isActiveBox(el) && containerGroupOf(el) === group) return el;
  }
  return null;
}

export const isBoundText = (el: El): boolean =>
  el.type === "text" && !!(el as { containerId?: string | null }).containerId;

export const isBoundLinear = (el: El): boolean =>
  (el.type === "arrow" || el.type === "line") &&
  !!(
    (el as { startBinding?: unknown }).startBinding || (el as { endBinding?: unknown }).endBinding
  );

export interface Unit {
  /** The element id, or the next-inner group id for grouped children. */
  key: string;
  ids: string[];
  /** Scene order of the unit's first element (z-order tie-break). */
  z: number;
}

/**
 * Children of the container `group` as layout units. `members` are the elements carrying the
 * group in scene order (deleted ones are skipped). A child whose innermost group is `group` is
 * its own unit (with its bound text); otherwise the unit is the group just inside `group` (a
 * nested container, a component instance, a user group). Arrows and lines bound to something
 * are left to the arrow follower.
 */
export function unitsOf(members: readonly El[], group: string, boxId: string): Unit[] {
  const units = new Map<string, Unit>();
  const unitOfEl = new Map<string, string>();
  const textOf = new Map<string, string>();
  members.forEach((el, z) => {
    if (el.isDeleted || el.id === boxId) return;
    const at = el.groupIds.indexOf(group);
    if (at < 0) return;
    if (isBoundText(el)) {
      textOf.set(el.id, (el as unknown as { containerId: string }).containerId);
      return;
    }
    if (at === 0 && isBoundLinear(el)) return;
    const key = at === 0 ? el.id : el.groupIds[at - 1];
    unitOfEl.set(el.id, key);
    let u = units.get(key);
    if (!u) units.set(key, (u = { key, ids: [], z }));
    u.ids.push(el.id);
  });
  for (const [textId, cid] of textOf) {
    const key = unitOfEl.get(cid);
    if (key) units.get(key)!.ids.push(textId);
  }
  return [...units.values()];
}
