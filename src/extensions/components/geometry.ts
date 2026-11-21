/**
 * Instance transforms for Components v1. An instance is the master scaled by (sx, sy), rotated
 * by `angle` and placed at `(ox, oy)`: for a master child whose centre is `b` relative to the
 * master origin, the instance child's centre is `O + R(angle)·(sx·b.cx, sy·b.cy)`.
 *
 * The transform isn't stored: it is inferred from an instance child's current geometry and the
 * `base` (master-relative geometry) recorded on it at the last sync. So moving, resizing or
 * rotating a whole instance just changes the inferred transform, and editing the master
 * re-derives every child under the instance's own transform.
 */
import type { El } from "../reactor/reactor";
import type { Base } from "./model";

export interface Transform {
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  angle: number;
}

const EPS = 1e-6;
const TAU = Math.PI * 2;

export const isPointy = (el: El): el is El & { points: readonly (readonly [number, number])[] } =>
  el.type === "arrow" || el.type === "line" || el.type === "freedraw";

export const isBoundText = (el: El) =>
  el.type === "text" && !!(el as { containerId?: string | null }).containerId;

export function normAngle(a: number): number {
  const r = a % TAU;
  const out = r < 0 ? r + TAU : r;
  return Math.abs(out - TAU) < EPS || Math.abs(out) < EPS ? 0 : out;
}

function pointsBox(points: readonly (readonly [number, number])[]) {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  points.forEach(([x, y], i) => {
    if (i === 0 || x < minX) minX = x;
    if (i === 0 || y < minY) minY = y;
    if (i === 0 || x > maxX) maxX = x;
    if (i === 0 || y > maxY) maxY = y;
  });
  return { minX, minY, maxX, maxY };
}

/** Centre, size and angle of an element's own (unrotated) box. */
export function boxOf(el: El): { cx: number; cy: number; w: number; h: number; angle: number } {
  if (isPointy(el) && el.points.length) {
    const b = pointsBox(el.points);
    return {
      cx: el.x + (b.minX + b.maxX) / 2,
      cy: el.y + (b.minY + b.maxY) / 2,
      w: b.maxX - b.minX,
      h: b.maxY - b.minY,
      angle: el.angle,
    };
  }
  return {
    cx: el.x + el.width / 2,
    cy: el.y + el.height / 2,
    w: el.width,
    h: el.height,
    angle: el.angle,
  };
}

/** Top-left of the axis-aligned box around `els` (bound text ignored unless it's all there is). */
export function originOf(els: readonly El[]): { x: number; y: number } {
  const use = els.some((e) => !isBoundText(e)) ? els.filter((e) => !isBoundText(e)) : els;
  let x = Infinity;
  let y = Infinity;
  for (const el of use) {
    if (isPointy(el) && el.points.length) {
      const b = pointsBox(el.points);
      x = Math.min(x, el.x + b.minX);
      y = Math.min(y, el.y + b.minY);
    } else {
      x = Math.min(x, el.x);
      y = Math.min(y, el.y);
    }
  }
  return Number.isFinite(x) ? { x, y } : { x: 0, y: 0 };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function baseOf(el: El, origin: { x: number; y: number }): Base {
  const b = boxOf(el);
  return {
    cx: round(b.cx - origin.x),
    cy: round(b.cy - origin.y),
    w: round(b.w),
    h: round(b.h),
    angle: round(b.angle),
  };
}

/** The transform that maps `base` onto `el`'s current geometry. */
export function inferTransform(el: El, base: Base): Transform {
  const c = boxOf(el);
  let sx = Math.abs(base.w) > EPS ? c.w / base.w : NaN;
  let sy = Math.abs(base.h) > EPS ? c.h / base.h : NaN;
  if (!Number.isFinite(sx) || sx <= EPS) sx = Number.isFinite(sy) && sy > EPS ? sy : 1;
  if (!Number.isFinite(sy) || sy <= EPS) sy = sx;
  const angle = normAngle(c.angle - base.angle);
  const [rx, ry] = rotate(sx * base.cx, sy * base.cy, angle);
  return { ox: c.cx - rx, oy: c.cy - ry, sx, sy, angle };
}

export function rotate(x: number, y: number, a: number): [number, number] {
  if (!a) return [x, y];
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [x * cos - y * sin, x * sin + y * cos];
}

/** Translation-only transform placing a master-relative base at `origin`. */
export const translation = (origin: { x: number; y: number }): Transform => ({
  ox: origin.x,
  oy: origin.y,
  sx: 1,
  sy: 1,
  angle: 0,
});

const snap = (n: number) => (Math.abs(n - Math.round(n)) < 1e-6 ? Math.round(n) : n);

/**
 * Geometry for the instance copy of master child `m` (whose base is `base`) under `t`.
 * Returns `x`, `y`, `width`, `height`, `angle` and, for linear/freedraw, scaled `points`.
 */
export function placeGeometry(m: El, base: Base, t: Transform): Record<string, unknown> {
  const [rx, ry] = rotate(t.sx * base.cx, t.sy * base.cy, t.angle);
  const cx = t.ox + rx;
  const cy = t.oy + ry;
  const angle = normAngle(base.angle + t.angle);
  if (isPointy(m) && m.points.length) {
    const points = m.points.map(
      ([px, py]) => [snap(px * t.sx), snap(py * t.sy)] as [number, number],
    );
    const b = pointsBox(points);
    return {
      x: snap(cx - (b.minX + b.maxX) / 2),
      y: snap(cy - (b.minY + b.maxY) / 2),
      width: snap(b.maxX - b.minX),
      height: snap(b.maxY - b.minY),
      angle,
      points,
    };
  }
  const w = base.w * t.sx;
  const h = base.h * t.sy;
  return { x: snap(cx - w / 2), y: snap(cy - h / 2), width: snap(w), height: snap(h), angle };
}

/** Distance between two transforms (to decide whether a candidate agrees with the majority). */
export function sameTransform(a: Transform, b: Transform, tol = 0.5): boolean {
  return (
    Math.abs(a.ox - b.ox) < tol &&
    Math.abs(a.oy - b.oy) < tol &&
    Math.abs(a.sx - b.sx) < 1e-3 &&
    Math.abs(a.sy - b.sy) < 1e-3 &&
    Math.abs(normAngle(a.angle - b.angle)) < 1e-4
  );
}
