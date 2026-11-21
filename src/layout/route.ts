/**
 * Orthogonal obstacle-avoiding router for "Tidy Arrows" (docs/plan.md D-DX14).
 *
 * Pure geometry: shapes are axis-aligned boxes and never move. Each arrow is routed with A* over
 * a sparse grid whose lines come from the obstacles' clearance edges, the ports, earlier routes
 * and the midlines between them. The search state includes the heading, so bends cost extra.
 * Obstacles are hard (a path may run along but never enter one) and their clearance margin is
 * soft (allowed but expensive), so tight layouts still route. Arrows that share a start (or end)
 * shape get a discount on segments earlier arrows of that shape used, so they share an
 * org-chart-style trunk; a slight preference for the middle of wide channels puts that bus
 * half-way between rows.
 */
import type { Box } from "../agent/scene/draft";

export type Side = "n" | "e" | "s" | "w";
export type Pt = [number, number];

export interface Port {
  side: Side;
  /** Where the arrow end sits (just outside the shape, on `side`). */
  point: Pt;
}

export interface RouteEnd {
  /** Key for trunk sharing (usually the bound element id). */
  key: string;
  /** The bound shape's box: never crossed by its own arrow. */
  box: Box;
  /** Candidate ports; the router picks the cheapest. */
  ports: Port[];
}

export interface Obstacle {
  id: string;
  box: Box;
}

export interface RouteRequest {
  id: string;
  start: RouteEnd;
  end: RouteEnd;
  /** Obstacle ids this arrow ignores (e.g. the group/frame nodes holding its ends). */
  ignore?: ReadonlySet<string>;
  /** Extra obstacles for this arrow only (e.g. the other members of an ignored group). */
  extra?: readonly Obstacle[];
}

export interface RouteResult {
  /** Absolute points, port to port, axis-aligned with no collinear or duplicate points. */
  points: Pt[];
  startSide: Side;
  endSide: Side;
}

export interface RouteOptions {
  /** Preferred free space around obstacles, px. */
  clearance?: number;
  /** Cost of one bend, in px of path length. */
  bendPenalty?: number;
  /** Length of the straight stub out of a port, px. */
  stub?: number;
}

const DIRS: readonly Pt[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
/** Heading out of each side, as an index into DIRS. */
export const SIDE_DIR: Record<Side, number> = { e: 0, s: 1, w: 2, n: 3 };
/** A path may come this close to an obstacle (it's slightly inflated for the hard test). */
const HARD = 2;
/** Cost multiplier inside another shape's clearance margin. */
const SOFT = 3;
/** Cost multiplier on a segment an earlier arrow of the same shape already uses. */
const TRUNK = 0.3;
/** Cost multiplier for running in line with (but not on) an earlier route: aligns the buses. */
const ALIGN = 0.9;
/** Max discount for running down the middle of a wide channel (tie-breaker). */
const CENTER = 0.02;
const CELL = 256;
/** Upper bound on grid nodes (x4 headings) per search, to keep memory and time bounded. */
const MAX_NODES = 250_000;
const EPS = 1e-6;

/** Route every request. Unroutable arrows map to null. Deterministic for a given input. */
export function routeArrows(
  obstacles: readonly Obstacle[],
  requests: readonly RouteRequest[],
  opts: RouteOptions = {},
): Map<string, RouteResult | null> {
  const clearance = opts.clearance ?? 20;
  const bend = opts.bendPenalty ?? 40;
  const stub = opts.stub ?? 20;
  const index = new SpatialIndex(obstacles);
  const scene = sceneBounds(obstacles, requests);
  const trunks = new Map<string, Seg[]>();
  const out = new Map<string, RouteResult | null>();

  // Per start shape, the farthest arrow first: it lays the bus the nearer ones then branch off.
  const order = [...requests].sort(
    (a, b) =>
      cmp(a.start.key, b.start.key) || endDistance(b) - endDistance(a) || cmp(a.id, b.id),
  );
  for (const req of order) {
    const shared = [
      ...(trunks.get(`s:${req.start.key}`) ?? []),
      ...(trunks.get(`e:${req.end.key}`) ?? []),
    ];
    const ctx: RouteCtx = { req, index, clearance, bend, stub, shared };
    const near = expand(endsBounds(req), Math.max(4 * clearance + 2 * stub, 160));
    const result = search(ctx, near) ?? search(ctx, expand(scene, 2 * (clearance + stub)));
    out.set(req.id, result);
    if (!result) continue;
    const segs = toSegs(result.points);
    for (const key of [`s:${req.start.key}`, `e:${req.end.key}`]) {
      const list = trunks.get(key);
      if (list) list.push(...segs);
      else trunks.set(key, [...segs]);
    }
  }
  return out;
}

/** True when an axis-aligned polyline enters `box`'s interior (touching its edge is fine). */
export function pathCrossesBox(points: readonly Pt[], box: Box): boolean {
  for (let i = 1; i < points.length; i++) {
    if (crossesInterior(points[i - 1], points[i], box)) return true;
  }
  return false;
}

// --- search -------------------------------------------------------------------

interface Seg {
  a: Pt;
  b: Pt;
}

interface RouteCtx {
  req: RouteRequest;
  index: SpatialIndex;
  clearance: number;
  bend: number;
  stub: number;
  shared: Seg[];
}

interface PortStub extends Port {
  stub: Pt;
  dir: number;
}

function search(ctx: RouteCtx, window: Box): RouteResult | null {
  const { req, index, clearance, bend, stub, shared } = ctx;
  const skip = new Set(req.ignore ?? []);
  // Anything overlapping an end shape is a container or decoration of it, not an obstacle.
  for (const box of [req.start.box, req.end.box]) {
    for (const o of index.query(box)) if (overlaps(o.box, box)) skip.add(o.id);
  }
  const extra = (req.extra ?? []).filter(
    (o) => !overlaps(o.box, req.start.box) && !overlaps(o.box, req.end.box),
  );
  const own = [expand(req.start.box, HARD), expand(req.end.box, HARD)];

  /** -1 = blocked, else the cost multiplier for running along this segment. */
  const segmentCost = (a: Pt, b: Pt): number => {
    for (const h of own) if (crossesInterior(a, b, h)) return -1;
    let mult = 1;
    const blocked = (o: Obstacle) => {
      if (skip.has(o.id)) return false;
      if (crossesInterior(a, b, expand(o.box, HARD))) return true;
      if (mult === 1 && crossesInterior(a, b, expand(o.box, clearance))) mult = SOFT;
      return false;
    };
    for (const o of index.query(expand(segBox(a, b), clearance))) if (blocked(o)) return -1;
    for (const o of extra) if (blocked(o)) return -1;
    return mult;
  };

  const withStub = (p: Port): PortStub => {
    const dir = SIDE_DIR[p.side];
    return {
      ...p,
      dir,
      stub: [p.point[0] + DIRS[dir][0] * stub, p.point[1] + DIRS[dir][1] * stub],
    };
  };
  // Ports whose stub is blocked can't be used.
  const starts = req.start.ports.map(withStub).filter((p) => segmentCost(p.point, p.stub) > 0);
  const ends = req.end.ports.map(withStub).filter((p) => segmentCost(p.point, p.stub) > 0);
  if (!starts.length || !ends.length) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  const addBox = (b: Box) => {
    const s = expand(b, clearance);
    xs.push(s.minX, s.maxX);
    ys.push(s.minY, s.maxY);
  };
  for (const o of index.query(window)) if (!skip.has(o.id)) addBox(o.box);
  for (const o of extra) addBox(o.box);
  addBox(req.start.box);
  addBox(req.end.box);
  for (const p of [...starts, ...ends]) {
    xs.push(p.stub[0]);
    ys.push(p.stub[1]);
  }
  for (const s of shared) {
    xs.push(s.a[0], s.b[0]);
    ys.push(s.a[1], s.b[1]);
  }
  let gx = gridLines(xs, window, "x", true);
  let gy = gridLines(ys, window, "y", true);
  if (gx.at.length * gy.at.length > MAX_NODES) {
    gx = gridLines(xs, window, "x", false);
    gy = gridLines(ys, window, "y", false);
    if (gx.at.length * gy.at.length > MAX_NODES) return null;
  }
  const nx = gx.at.length;
  const ny = gy.at.length;
  const xi = new Map(gx.at.map((v, i) => [v, i]));
  const yi = new Map(gy.at.map((v, i) => [v, i]));
  const nodeOf = (p: Pt) => {
    const i = xi.get(p[0]);
    const j = yi.get(p[1]);
    return i === undefined || j === undefined ? -1 : j * nx + i;
  };

  // Lazily evaluated edge costs (0 = not computed yet). Edge k joins node k to its right (h)
  // or lower (v) neighbour.
  const busY = new Set(shared.filter((s) => s.a[1] === s.b[1]).map((s) => s.a[1]));
  const busX = new Set(shared.filter((s) => s.a[0] === s.b[0]).map((s) => s.a[0]));
  const hCost = new Float64Array(nx * ny);
  const vCost = new Float64Array(nx * ny);
  const edgeCost = (from: number, dir: number): number => {
    const i = from % nx;
    const j = (from - i) / nx;
    const ti = i + DIRS[dir][0];
    const tj = j + DIRS[dir][1];
    if (ti < 0 || tj < 0 || ti >= nx || tj >= ny) return -1;
    const horizontal = dir === 0 || dir === 2;
    const k = horizontal ? j * nx + Math.min(i, ti) : Math.min(j, tj) * nx + i;
    const cache = horizontal ? hCost : vCost;
    if (cache[k] !== 0) return cache[k];
    const a: Pt = [gx.at[i], gy.at[j]];
    const b: Pt = [gx.at[ti], gy.at[tj]];
    let c = segmentCost(a, b);
    if (c > 0) {
      if (shared.some((s) => onSeg(s, a, b))) c *= TRUNK;
      else if (horizontal ? busY.has(a[1]) : busX.has(a[0])) c *= ALIGN;
      c *= 1 - CENTER * (horizontal ? gy.weight[j] : gx.weight[i]);
      c *= Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    }
    cache[k] = c;
    return c;
  };

  const targets = ends.map((p) => ({ ...p, node: nodeOf(p.stub) }));
  const scale = (shared.length ? TRUNK : 1) * (1 - CENTER);
  const h = (n: number) => {
    const x = gx.at[n % nx];
    const y = gy.at[Math.floor(n / nx)];
    let best = Infinity;
    for (const t of targets) {
      best = Math.min(best, Math.abs(x - t.stub[0]) + Math.abs(y - t.stub[1]));
    }
    return best * scale;
  };

  // State = node * 4 + heading. Goal entries are pushed as negative ids (-1 - target index)
  // with their full path cost, so the first one popped is optimal.
  const g = new Float64Array(nx * ny * 4).fill(Infinity);
  const prev = new Int32Array(nx * ny * 4).fill(-1);
  const startOf = new Map<number, PortStub>();
  const goalCost = new Map<number, number>();
  const goalState = new Map<number, number>();
  const heap = new MinHeap();
  for (const p of starts) {
    const n = nodeOf(p.stub);
    if (n < 0) continue;
    const st = n * 4 + p.dir;
    if (stub < g[st]) {
      g[st] = stub;
      startOf.set(st, p);
      heap.push(stub + h(n), st);
    }
  }
  while (heap.size) {
    const [f, st] = heap.pop();
    if (st < 0) {
      if (f > (goalCost.get(st) ?? Infinity) + EPS) continue;
      return finish(goalState.get(st)!, targets[-1 - st]);
    }
    const n = st >> 2;
    const dir = st & 3;
    if (f - h(n) > g[st] + EPS) continue;
    for (let ti = 0; ti < targets.length; ti++) {
      const t = targets[ti];
      // Arrive heading into the port; never come back out of the shape's side.
      if (t.node !== n || dir === t.dir) continue;
      const total = g[st] + stub + (dir === (t.dir + 2) % 4 ? 0 : bend);
      const key = -1 - ti;
      if (total + EPS < (goalCost.get(key) ?? Infinity)) {
        goalCost.set(key, total);
        goalState.set(key, st);
        heap.push(total, key);
      }
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (dir + 2) % 4) continue;
      const c = edgeCost(n, nd);
      if (c < 0) continue;
      const m = n + DIRS[nd][0] + DIRS[nd][1] * nx;
      const ns = m * 4 + nd;
      const ng = g[st] + c + (nd === dir ? 0 : bend);
      if (ng + EPS < g[ns]) {
        g[ns] = ng;
        prev[ns] = st;
        heap.push(ng + h(m), ns);
      }
    }
  }
  return null;

  function finish(last: number, t: PortStub): RouteResult {
    const path: Pt[] = [];
    let first = last;
    for (let st = last; st >= 0; st = prev[st]) {
      const n = st >> 2;
      path.push([gx.at[n % nx], gy.at[Math.floor(n / nx)]]);
      first = st;
    }
    path.reverse();
    const s = startOf.get(first)!;
    return { points: simplify([s.point, ...path, t.point]), startSide: s.side, endSide: t.side };
  }
}

// --- geometry helpers ------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function center(b: Box): Pt {
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

function endDistance(r: RouteRequest): number {
  const a = center(r.start.box);
  const b = center(r.end.box);
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function union(boxes: Iterable<Box>): Box {
  const u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const b of boxes) {
    u.minX = Math.min(u.minX, b.minX);
    u.minY = Math.min(u.minY, b.minY);
    u.maxX = Math.max(u.maxX, b.maxX);
    u.maxY = Math.max(u.maxY, b.maxY);
  }
  return u;
}

function endsBounds(r: RouteRequest): Box {
  return union([r.start.box, r.end.box]);
}

function sceneBounds(obstacles: readonly Obstacle[], requests: readonly RouteRequest[]): Box {
  return union([
    ...obstacles.map((o) => o.box),
    ...requests.flatMap((r) => [r.start.box, r.end.box]),
  ]);
}

export function expand(b: Box, d: number): Box {
  return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
}

/** Positive-area overlap. */
function overlaps(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

function segBox(a: Pt, b: Pt): Box {
  return {
    minX: Math.min(a[0], b[0]),
    minY: Math.min(a[1], b[1]),
    maxX: Math.max(a[0], b[0]),
    maxY: Math.max(a[1], b[1]),
  };
}

/** Axis-aligned segment a→b passes through the open interior of `box`. */
function crossesInterior(a: Pt, b: Pt, box: Box): boolean {
  const s = segBox(a, b);
  if (s.minY === s.maxY) {
    return (
      s.minY > box.minY + EPS &&
      s.minY < box.maxY - EPS &&
      Math.max(s.minX, box.minX) < Math.min(s.maxX, box.maxX) - EPS
    );
  }
  if (s.minX === s.maxX) {
    return (
      s.minX > box.minX + EPS &&
      s.minX < box.maxX - EPS &&
      Math.max(s.minY, box.minY) < Math.min(s.maxY, box.maxY) - EPS
    );
  }
  // Not axis-aligned (never produced here): fall back to bounding-box overlap.
  return overlaps(s, box);
}

/** Sub-segment a→b lies on segment s. */
function onSeg(s: Seg, a: Pt, b: Pt): boolean {
  const box = segBox(s.a, s.b);
  const inside = (p: Pt) =>
    p[0] >= box.minX - EPS &&
    p[0] <= box.maxX + EPS &&
    p[1] >= box.minY - EPS &&
    p[1] <= box.maxY + EPS;
  return inside(a) && inside(b);
}

function toSegs(points: readonly Pt[]): Seg[] {
  const segs: Seg[] = [];
  for (let i = 1; i < points.length; i++) segs.push({ a: points[i - 1], b: points[i] });
  return segs;
}

/** Drop duplicate and collinear interior points. */
export function simplify(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = last!;
      const sameX = Math.abs(a[0] - b[0]) < EPS && Math.abs(b[0] - p[0]) < EPS;
      const sameY = Math.abs(a[1] - b[1]) < EPS && Math.abs(b[1] - p[1]) < EPS;
      if (sameX || sameY) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/**
 * Sorted unique grid coordinates inside `window`, plus (optionally) the midline of every gap.
 * Midlines carry a weight in [0, 1] proportional to the gap, used to prefer wide channels.
 */
function gridLines(
  values: number[],
  window: Box,
  axis: "x" | "y",
  midlines: boolean,
): { at: number[]; weight: number[] } {
  const lo = axis === "x" ? window.minX : window.minY;
  const hi = axis === "x" ? window.maxX : window.maxY;
  const base = [...new Set([lo, hi, ...values.filter((v) => v >= lo && v <= hi)])].sort(
    (a, b) => a - b,
  );
  if (!midlines) return { at: base, weight: base.map(() => 0) };
  let maxGap = 0;
  for (let i = 1; i < base.length; i++) maxGap = Math.max(maxGap, base[i] - base[i - 1]);
  const at: number[] = [];
  const weight: number[] = [];
  for (let i = 0; i < base.length; i++) {
    if (i > 0) {
      const gap = base[i] - base[i - 1];
      if (gap > 2) {
        at.push((base[i] + base[i - 1]) / 2);
        weight.push(maxGap > 0 ? gap / maxGap : 0);
      }
    }
    at.push(base[i]);
    weight.push(0);
  }
  return { at, weight };
}

class SpatialIndex {
  private cells = new Map<string, Obstacle[]>();

  constructor(obstacles: readonly Obstacle[]) {
    for (const o of obstacles) this.forCells(o.box, (k) => this.bucket(k).push(o));
  }

  query(box: Box): Obstacle[] {
    const seen = new Set<Obstacle>();
    this.forCells(box, (k) => {
      for (const o of this.cells.get(k) ?? []) seen.add(o);
    });
    return [...seen];
  }

  private bucket(k: string): Obstacle[] {
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    return list;
  }

  private forCells(b: Box, fn: (key: string) => void) {
    const x0 = Math.floor(b.minX / CELL);
    const x1 = Math.floor(b.maxX / CELL);
    const y0 = Math.floor(b.minY / CELL);
    const y1 = Math.floor(b.maxY / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(`${x},${y}`);
  }
}

/** Binary min-heap of (priority, value). */
class MinHeap {
  private p: number[] = [];
  private v: number[] = [];

  get size(): number {
    return this.p.length;
  }

  push(priority: number, value: number) {
    const { p, v } = this;
    let i = p.length;
    p.push(priority);
    v.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (p[parent] <= priority) break;
      p[i] = p[parent];
      v[i] = v[parent];
      i = parent;
    }
    p[i] = priority;
    v[i] = value;
  }

  pop(): [number, number] {
    const { p, v } = this;
    const top: [number, number] = [p[0], v[0]];
    const lp = p.pop()!;
    const lv = v.pop()!;
    if (p.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= p.length) break;
        const r = l + 1;
        const c = r < p.length && p[r] < p[l] ? r : l;
        if (p[c] >= lp) break;
        p[i] = p[c];
        v[i] = v[c];
        i = c;
      }
      p[i] = lp;
      v[i] = lv;
    }
    return top;
  }
}
