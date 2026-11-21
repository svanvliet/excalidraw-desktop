/**
 * Line anchors (docs/plan.md D-DX15, FR-61): pin an arrow end to the middle of one face of its
 * shape (n / e / s / w) or to its centre, so it stays there when the shape moves, resizes or
 * rotates until the user drags that end off.
 *
 * - Elbow arrows already pin through the binding's `fixedPoint` (D-DX8, `elbowAnchors.ts`); a
 *   snap just sets that anchor. A centre snap resolves to the side facing the other end.
 * - Straight and curved arrows bind with focus/gap and slide around the outline, so the pin lives
 *   in `customData[PIN_KEY]` and the anchors reactor rule puts the end back on it
 *   (`pinnedPatch`). A pin only counts while that end is still bound to the pinned shape.
 * - "center" on a straight/curved arrow means "aim at the centre": the end sits on the outline
 *   where the line from the centre towards the neighbouring point leaves the shape (focus 0).
 */
import type { ExcalidrawElement, PointBinding } from "@excalidraw/excalidraw/element/types";
import {
  anchorPoint,
  type Anchor,
  centerOf,
  FIXED_BINDING_DISTANCE,
  fixedPointFor,
  isElbowArrow,
  resolveSide,
  sideOf,
  SIDES,
} from "./elbowAnchors";

export const PIN_KEY = "excalidrawDesktop.pin";
/** Release within this many screen pixels of a dot to snap. */
export const SNAP_TOLERANCE_PX = 12;
export const PIN_GAP = FIXED_BINDING_DISTANCE;

export type End = "start" | "end";
export const ENDS: readonly End[] = ["start", "end"];
export interface EndPin {
  /** The shape the end is pinned to; the pin is ignored once the end is bound elsewhere. */
  id: string;
  anchor: Anchor;
}
export type Pin = Partial<Record<End, EndPin>>;

type El = ExcalidrawElement;
type Point = readonly [number, number];
type Shape = Pick<El, "x" | "y" | "width" | "height" | "angle" | "type">;
type Linear = El & {
  points: readonly (readonly [number, number])[];
  startBinding: PointBinding | null;
  endBinding: PointBinding | null;
};

const SNAP_TYPES = new Set(["rectangle", "ellipse", "diamond", "image", "embeddable", "iframe"]);

/** Shapes an arrow end can snap to (Excalidraw's bindable elements, minus frames). */
export function isSnapTarget(el: El): boolean {
  if (el.isDeleted) return false;
  if (el.type === "text") return !(el as { containerId?: string | null }).containerId;
  return SNAP_TYPES.has(el.type);
}

export function isArrow(el: El | undefined): el is Linear {
  return !!el && el.type === "arrow";
}

const isAnchor = (v: unknown): v is Anchor =>
  v === "center" || (SIDES as readonly unknown[]).includes(v);

function readEnd(v: unknown): EndPin | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { id, anchor } = v as Record<string, unknown>;
  return typeof id === "string" && isAnchor(anchor) ? { id, anchor } : undefined;
}

/** The arrow's stored pin (straight/curved arrows only). */
export function pinOf(el: El | undefined): Pin {
  const raw = (el?.customData as Record<string, unknown> | undefined)?.[PIN_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out: Pin = {};
  for (const end of ENDS) {
    const p = readEnd((raw as Record<string, unknown>)[end]);
    if (p) out[end] = p;
  }
  return out;
}

export const hasPin = (el: El | undefined): boolean =>
  isArrow(el) && !isElbowArrow(el) && Object.keys(pinOf(el)).length > 0;

/** `customData` with `end`'s pin set (or cleared with `null`). Returns the same object if unchanged. */
export function withPin(el: El, end: End, pin: EndPin | null): Record<string, unknown> | undefined {
  const current = pinOf(el);
  const prev = current[end];
  if (pin ? prev?.id === pin.id && prev.anchor === pin.anchor : !prev) {
    return el.customData as Record<string, unknown> | undefined;
  }
  const next: Pin = { ...current };
  if (pin) next[end] = pin;
  else delete next[end];
  const data = { ...(el.customData ?? {}) } as Record<string, unknown>;
  if (Object.keys(next).length) data[PIN_KEY] = next;
  else delete data[PIN_KEY];
  return data;
}

/** The pinned anchor of an end that is still bound to its pinned shape. */
export function activePin(arrow: Linear, end: End): EndPin | undefined {
  const pin = pinOf(arrow)[end];
  const binding = end === "start" ? arrow.startBinding : arrow.endBinding;
  return pin && binding?.elementId === pin.id ? pin : undefined;
}

// ---------------------------------------------------------------- geometry

function rotate(p: Point, c: Point, angle: number): [number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
}

/** Snap dots: each face midpoint on the outline, plus the centre. */
export function snapDots(shape: Shape): Array<{ anchor: Anchor; point: [number, number] }> {
  const c = centerOf(shape);
  const { x, y, width: w, height: h, angle } = shape;
  const local: Record<Anchor, Point> = {
    n: [x + w / 2, y],
    e: [x + w, y + h / 2],
    s: [x + w / 2, y + h],
    w: [x, y + h / 2],
    center: c,
  };
  return (["n", "e", "s", "w", "center"] as const).map((anchor) => ({
    anchor,
    point: rotate(local[anchor], c, angle),
  }));
}

export interface SnapHit {
  shape: El;
  anchor: Anchor;
  point: [number, number];
  distance: number;
}

/**
 * The dot nearest `point` within `tolerance` (scene units). `prefer` wins ties within the
 * tolerance (the shape the end is already bound to).
 */
export function nearestDot(
  shapes: Iterable<El>,
  point: Point,
  tolerance: number,
  prefer?: string | null,
): SnapHit | null {
  let best: SnapHit | null = null;
  for (const shape of shapes) {
    if (!isSnapTarget(shape)) continue;
    for (const dot of snapDots(shape)) {
      const distance = Math.hypot(dot.point[0] - point[0], dot.point[1] - point[1]);
      if (distance > tolerance) continue;
      const better =
        !best ||
        (shape.id === prefer && best.shape.id !== prefer) ||
        ((shape.id === prefer) === (best.shape.id === prefer) && distance < best.distance);
      if (better) best = { shape, anchor: dot.anchor, point: dot.point, distance };
    }
  }
  return best;
}

/** Where the ray from the shape's centre towards `toward` leaves its outline, plus `gap`. */
export function outlinePoint(shape: Shape, toward: Point, gap: number): [number, number] {
  const c = centerOf(shape);
  const [lx, ly] = rotate(toward, c, -shape.angle);
  let dx = lx - c[0];
  let dy = ly - c[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = 0;
    dy = -1;
  } else {
    dx /= len;
    dy /= len;
  }
  const hw = Math.max(shape.width / 2, 1e-6);
  const hh = Math.max(shape.height / 2, 1e-6);
  let t: number;
  if (shape.type === "ellipse") t = 1 / Math.hypot(dx / hw, dy / hh);
  else if (shape.type === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else
    t = Math.min(
      Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity,
    );
  return rotate([c[0] + dx * (t + gap), c[1] + dy * (t + gap)], c, shape.angle);
}

/** Global position of a pinned end; `toward` is the neighbouring point (used by "center"). */
export function pinnedPoint(shape: Shape, anchor: Anchor, toward: Point): [number, number] {
  return anchor === "center" ? outlinePoint(shape, toward, PIN_GAP) : anchorPoint(anchor, shape);
}

function segmentIntersection(
  a: readonly [Point, Point],
  b: readonly [Point, Point],
): [number, number] | null {
  const [p, p2] = a;
  const [q, q2] = b;
  const r = [p2[0] - p[0], p2[1] - p[1]];
  const s = [q2[0] - q[0], q2[1] - q[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < 1e-12) return null;
  const qp = [q[0] - p[0], q[1] - p[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p[0] + t * r[0], p[1] + t * r[1]];
}

/**
 * Excalidraw 0.18.1's `determineFocusDistance` (not exported), so a pinned end's binding carries
 * the focus Excalidraw itself would compute: its own per-frame updates during a drag then land
 * on (or next to) the pin before the rule re-snaps it. `a` is the neighbouring point, `b` the end.
 */
export function focusDistance(el: Shape, a: Point, b: Point): number {
  const { x, y, width: w, height: h } = el;
  const center: Point = [x + w / 2, y + h / 2];
  if (a[0] === b[0] && a[1] === b[1]) return 0;
  const ra = rotate(a, center, -el.angle);
  const rb = rotate(b, center, -el.angle);
  const cross = (u: Point, v: Point) => u[0] * v[1] - u[1] * v[0];
  // Upstream measures this against the unrotated `a`; kept as-is so the sign matches.
  const sign =
    Math.sign(cross([rb[0] - a[0], rb[1] - a[1]], [rb[0] - center[0], rb[1] - center[1]])) * -1;
  const dir = [ra[0] - rb[0], ra[1] - rb[1]];
  const dlen = Math.hypot(dir[0], dir[1]) || 1;
  const reach = Math.max(w * 2, h * 2);
  const interceptor: [Point, Point] = [
    rb,
    [rb[0] + (dir[0] / dlen) * reach, rb[1] + (dir[1] / dlen) * reach],
  ];
  const diamond = el.type === "diamond";
  const axes: Array<[Point, Point]> = diamond
    ? [
        [
          [x + w / 2, y],
          [x + w / 2, y + h],
        ],
        [
          [x, y + h / 2],
          [x + w, y + h / 2],
        ],
      ]
    : [
        [
          [x, y],
          [x + w, y + h],
        ],
        [
          [x + w, y],
          [x, y + h],
        ],
      ];
  const interceptees: Array<[Point, Point]> = diamond
    ? [
        [
          [x + w / 2, y - h],
          [x + w / 2, y + h * 2],
        ],
        [
          [x - w, y + h / 2],
          [x + w * 2, y + h / 2],
        ],
      ]
    : [
        [
          [x - w, y - h],
          [x + w * 2, y + h * 2],
        ],
        [
          [x + w * 2, y - h],
          [x - w, y + h * 2],
        ],
      ];
  const d2 = (p: Point, q: Point) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
  const ordered = interceptees
    .map((seg) => segmentIntersection(interceptor, seg))
    .filter((p): p is [number, number] => p !== null)
    .sort((g, k) => d2(g, b) - d2(k, b))
    .map((p, idx) => {
      const scale = diamond
        ? Math.sqrt(d2(axes[idx][0], axes[idx][1])) / 2
        : Math.sqrt(w ** 2 + h ** 2) / 2;
      return (sign * Math.sqrt(d2(center, p))) / (scale || 1);
    })
    .sort((g, k) => Math.abs(g) - Math.abs(k));
  return ordered[0] ?? 0;
}

export interface ArrowGeometry {
  x: number;
  y: number;
  points: [number, number][];
  width: number;
  height: number;
}

export function absolutePoints(arrow: Pick<Linear, "x" | "y" | "points">): [number, number][] {
  return arrow.points.map(([px, py]) => [arrow.x + px, arrow.y + py]);
}

export function geometryFrom(abs: readonly Point[]): ArrowGeometry {
  const [ox, oy] = abs[0];
  const points = abs.map(([px, py]) => [px - ox, py - oy] as [number, number]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: ox,
    y: oy,
    points,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** The binding for an end pinned at `endPoint` (focus from the neighbouring point, gap 5). */
export function pinnedBinding(
  shape: Shape & { id: string },
  anchor: Anchor,
  neighbour: Point,
  endPoint: Point,
): PointBinding {
  return {
    elementId: shape.id,
    focus: anchor === "center" ? 0 : focusDistance(shape, neighbour, endPoint),
    gap: PIN_GAP,
  };
}

/** Within this many scene units an end counts as already on its pin (avoids rewrite churn). */
const EPS = 0.5;

/**
 * The patch that puts a straight/curved arrow's pinned ends back on their pins, or null when
 * they already are. Ends whose pin no longer matches their binding are left alone. `get` looks
 * up shapes (deleted ones are ignored).
 */
export function pinnedPatch(
  arrow: Linear,
  get: (id: string) => El | undefined,
  pin: Pin = pinOf(arrow),
): (ArrowGeometry & Partial<Pick<Linear, "startBinding" | "endBinding">>) | null {
  if (isElbowArrow(arrow) || arrow.points.length < 2) return null;
  const abs = absolutePoints(arrow);
  const last = abs.length - 1;
  const bindings: Partial<Pick<Linear, "startBinding" | "endBinding">> = {};
  let moved = false;
  for (const end of ENDS) {
    const p = pin[end];
    const binding = end === "start" ? arrow.startBinding : arrow.endBinding;
    if (!p || binding?.elementId !== p.id) continue;
    const shape = get(p.id);
    if (!shape || shape.isDeleted) continue;
    const i = end === "start" ? 0 : last;
    const neighbour = abs[end === "start" ? 1 : last - 1];
    const target = pinnedPoint(shape, p.anchor, neighbour);
    const want = pinnedBinding(shape, p.anchor, neighbour, target);
    if (Math.hypot(abs[i][0] - target[0], abs[i][1] - target[1]) > EPS) {
      abs[i] = target;
      moved = true;
    }
    if (
      binding.gap !== want.gap ||
      Math.abs(binding.focus - want.focus) > 1e-3 ||
      binding.elementId !== want.elementId
    ) {
      bindings[`${end}Binding`] = { ...binding, ...want };
    }
  }
  if (!moved && !Object.keys(bindings).length) return null;
  return { ...geometryFrom(abs), ...bindings };
}

export type ElementPatch = Record<string, unknown>;

/**
 * Patches that snap one end of `arrow` to `target` (bind + pin), or unpin it when `target` is
 * null. Elbow arrows get the anchor as a `fixedPoint` (the caller re-routes them); straight and
 * curved arrows get the end moved onto the pin, a focus/gap binding and the customData pin. The
 * shapes' `boundElements` are kept in step when the end moves to another shape.
 */
export function snapPatches(
  arrow: Linear,
  end: End,
  target: { shape: El; anchor: Anchor } | null,
  get: (id: string) => El | undefined,
): Map<string, ElementPatch> {
  const out = new Map<string, ElementPatch>();
  const key = end === "start" ? "startBinding" : "endBinding";
  const otherKey = end === "start" ? "endBinding" : "startBinding";
  const elbow = isElbowArrow(arrow);
  if (!target) {
    if (elbow) return out;
    const customData = withPin(arrow, end, null);
    if (customData !== arrow.customData) out.set(arrow.id, { customData });
    return out;
  }
  const { shape, anchor } = target;
  const prevId = arrow[key]?.elementId;
  if (prevId && prevId !== shape.id && arrow[otherKey]?.elementId !== prevId) {
    const prev = get(prevId);
    if (prev?.boundElements?.some((b) => b.id === arrow.id))
      out.set(prevId, { boundElements: prev.boundElements.filter((b) => b.id !== arrow.id) });
  }
  if (!shape.boundElements?.some((b) => b.id === arrow.id))
    out.set(shape.id, {
      boundElements: [...(shape.boundElements ?? []), { id: arrow.id, type: "arrow" }],
    });

  const abs = absolutePoints(arrow);
  const last = abs.length - 1;
  const i = end === "start" ? 0 : last;
  const neighbour = abs[end === "start" ? 1 : last - 1];
  if (elbow) {
    const otherShape = arrow[otherKey] ? get(arrow[otherKey]!.elementId) : undefined;
    const toward = otherShape ? centerOf(otherShape) : abs[end === "start" ? last : 0];
    const side = resolveSide(anchor, shape, toward);
    abs[i] = anchorPoint(side, shape);
    out.set(arrow.id, {
      ...geometryFrom(abs),
      [key]: { elementId: shape.id, focus: 0, gap: 0, fixedPoint: fixedPointFor(side, shape) },
    });
    return out;
  }
  abs[i] = pinnedPoint(shape, anchor, neighbour);
  out.set(arrow.id, {
    ...geometryFrom(abs),
    [key]: pinnedBinding(shape, anchor, neighbour, abs[i]),
    customData: withPin(arrow, end, { id: shape.id, anchor }),
  });
  return out;
}

/** Each end's anchor for display: elbow `fixedPoint` side, else the active customData pin. */
export function endAnchors(arrow: Linear): Record<End, Anchor | null> {
  if (isElbowArrow(arrow))
    return {
      start: sideOf(arrow.startBinding?.fixedPoint as never),
      end: sideOf(arrow.endBinding?.fixedPoint as never),
    };
  return {
    start: activePin(arrow, "start")?.anchor ?? null,
    end: activePin(arrow, "end")?.anchor ?? null,
  };
}
