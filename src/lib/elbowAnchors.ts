/**
 * Elbow-arrow anchor points (docs/plan.md D-DX8): pin a bound end to the north / east / south /
 * west side of its shape through the binding's `fixedPoint`.
 *
 * Verified against @excalidraw/excalidraw 0.18.1:
 *  - `fixedPoint` is a ratio of the bound element's unrotated box. The router only honours it when
 *    that point sits exactly FIXED_BINDING_DISTANCE outside the outline; anywhere else it snaps
 *    to the outline towards the other end. So N is [0.5, -5/height], etc. (0.5001 rather than
 *    0.5: Excalidraw nudges exact halves the same way to keep the heading stable).
 *  - A literal centre point doesn't route stably, so "center" resolves to the side facing the
 *    other end at the time it's set; it doesn't follow later moves.
 *  - Routing (`mutateElement` → `updateElbowArrowPoints`) reads the arrow's *current* binding and
 *    only finds bound shapes for elements that are live in a Scene. `rerouteElbowArrow` therefore
 *    works on live scene elements after the new bindings are in place.
 */
import { mutateElement, newElementWith } from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  ExcalidrawElbowArrowElement,
  FixedPointBinding,
} from "@excalidraw/excalidraw/element/types";

export const FIXED_BINDING_DISTANCE = 5;
export const SIDES = ["n", "e", "s", "w"] as const;
export type Side = (typeof SIDES)[number];
export type Anchor = Side | "center";
export const ANCHORS: readonly Anchor[] = [...SIDES, "center"];

type Box = Pick<ExcalidrawElement, "x" | "y" | "width" | "height" | "angle">;
type Point = readonly [number, number];

const HALF = 0.5001;

export function fixedPointFor(side: Side, el: Pick<Box, "width" | "height">): [number, number] {
  const dx = FIXED_BINDING_DISTANCE / Math.max(el.width, 1);
  const dy = FIXED_BINDING_DISTANCE / Math.max(el.height, 1);
  switch (side) {
    case "n":
      return [HALF, -dy];
    case "e":
      return [1 + dx, HALF];
    case "s":
      return [HALF, 1 + dy];
    case "w":
      return [-dx, HALF];
  }
}

/** The side a fixedPoint pins to, or null for any other point (e.g. one the user dragged). */
export function sideOf(fixedPoint: Point | null | undefined): Side | null {
  if (!fixedPoint) return null;
  const [x, y] = fixedPoint;
  const mid = (v: number) => Math.abs(v - 0.5) < 0.01;
  if (mid(x) && y < 0) return "n";
  if (mid(x) && y > 1) return "s";
  if (mid(y) && x < 0) return "w";
  if (mid(y) && x > 1) return "e";
  return null;
}

export const centerOf = (el: Box): [number, number] => [el.x + el.width / 2, el.y + el.height / 2];

/** The side of `el` that faces `toward`, in the element's own (unrotated) frame. */
export function facingSide(el: Box, toward: Point): Side {
  const [cx, cy] = centerOf(el);
  const cos = Math.cos(-el.angle);
  const sin = Math.sin(-el.angle);
  const vx = toward[0] - cx;
  const vy = toward[1] - cy;
  const lx = vx * cos - vy * sin;
  const ly = vx * sin + vy * cos;
  // Compare in units of the box's half-size so a wide box prefers its long sides.
  if (Math.abs(lx) / Math.max(el.width, 1) >= Math.abs(ly) / Math.max(el.height, 1)) {
    return lx >= 0 ? "e" : "w";
  }
  return ly >= 0 ? "s" : "n";
}

export function resolveSide(anchor: Anchor, el: Box, toward: Point): Side {
  return anchor === "center" ? facingSide(el, toward) : anchor;
}

/** Global point of a side anchor (on the unrotated outline, before rotation). */
export function anchorPoint(side: Side, el: Box): [number, number] {
  const [fx, fy] = fixedPointFor(side, el);
  const [cx, cy] = centerOf(el);
  const px = el.x + fx * el.width - cx;
  const py = el.y + fy * el.height - cy;
  const cos = Math.cos(el.angle);
  const sin = Math.sin(el.angle);
  return [cx + px * cos - py * sin, cy + px * sin + py * cos];
}

export function isElbowArrow(el: ExcalidrawElement): el is ExcalidrawElbowArrowElement {
  return el.type === "arrow" && "elbowed" in el && el.elbowed === true;
}

type Bindings = Partial<Pick<ExcalidrawElbowArrowElement, "startBinding" | "endBinding">>;

/**
 * Route a *live* elbow arrow (one mapped into a Scene, so the router can see its bound shapes)
 * with `bindings` applied, and return the result as a new element version. The live object is
 * restored afterwards: the store treats in-place changes as uncommitted and would leave them out
 * of the undo step, so callers must commit the returned copy through `updateScene`.
 */
export function routedElbow(
  live: ExcalidrawElbowArrowElement,
  bindings: Bindings = {},
): ExcalidrawElbowArrowElement {
  const target = live as unknown as Record<string, unknown>;
  const saved = { ...target };
  let routed: Record<string, unknown>;
  try {
    // The router reads the arrow's *current* bindings, so set them first, then route.
    if (Object.keys(bindings).length) mutateElement(live, bindings, false);
    mutateElement(
      live,
      {
        startBinding: live.startBinding ? { ...live.startBinding } : null,
        endBinding: live.endBinding ? { ...live.endBinding } : null,
      },
      false,
    );
    routed = { ...target };
  } finally {
    for (const k of Object.keys(target)) if (!(k in saved)) delete target[k];
    Object.assign(target, saved);
  }
  for (const k of ["id", "version", "versionNonce", "updated"]) delete routed[k];
  return newElementWith(live, routed as never, true);
}

export interface AnchorChange {
  start?: Anchor;
  end?: Anchor;
}

/**
 * New start/end bindings pinning an elbow arrow's bound ends to `change`. `get` looks up the
 * bound shapes. Throws (with a user-facing message) when an end isn't bound.
 */
export function anchorBindings(
  arrow: ExcalidrawElbowArrowElement,
  change: AnchorChange,
  get: (id: string) => Box | undefined,
): Bindings {
  const out: Bindings = {};
  const endpoint = (which: "start" | "end"): [number, number] => {
    const pts = arrow.points;
    const [px, py] = which === "start" ? pts[0] : pts[pts.length - 1];
    return [arrow.x + px, arrow.y + py];
  };
  for (const which of ["start", "end"] as const) {
    const anchor = change[which];
    if (!anchor) continue;
    const binding = which === "start" ? arrow.startBinding : arrow.endBinding;
    const el = binding ? get(binding.elementId) : undefined;
    if (!binding || !el) throw new Error(`The arrow's ${which} isn't bound to a shape`);
    const otherBinding = which === "start" ? arrow.endBinding : arrow.startBinding;
    const other = otherBinding ? get(otherBinding.elementId) : undefined;
    const toward = other ? centerOf(other) : endpoint(which === "start" ? "end" : "start");
    const side = resolveSide(anchor, el, toward);
    const next: FixedPointBinding = { ...binding, fixedPoint: fixedPointFor(side, el) as never };
    if (which === "start") out.startBinding = next;
    else out.endBinding = next;
  }
  return out;
}
