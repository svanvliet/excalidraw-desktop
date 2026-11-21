import { describe, expect, it } from "vitest";
import type { Box } from "../agent/scene/draft";
import {
  pathCrossesBox,
  routeArrows,
  type Obstacle,
  type Port,
  type Pt,
  type RouteRequest,
  type Side,
} from "./route";

const box = (x: number, y: number, w = 100, h = 60): Box => ({
  minX: x,
  minY: y,
  maxX: x + w,
  maxY: y + h,
});

function port(b: Box, side: Side): Port {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const point: Pt =
    side === "n"
      ? [cx, b.minY - 5]
      : side === "s"
        ? [cx, b.maxY + 5]
        : side === "w"
          ? [b.minX - 5, cy]
          : [b.maxX + 5, cy];
  return { side, point };
}

const ALL: Side[] = ["n", "e", "s", "w"];

function req(id: string, from: Obstacle, to: Obstacle, fromSides = ALL, toSides = ALL) {
  return {
    id,
    start: { key: from.id, box: from.box, ports: fromSides.map((s) => port(from.box, s)) },
    end: { key: to.id, box: to.box, ports: toSides.map((s) => port(to.box, s)) },
  } satisfies RouteRequest;
}

function expectOrthogonal(points: Pt[]) {
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
  }
}

function expectClear(points: Pt[], obstacles: Obstacle[], except: string[]) {
  for (const o of obstacles) {
    if (except.includes(o.id)) continue;
    expect(pathCrossesBox(points, o.box), `crosses ${o.id}`).toBe(false);
  }
}

/** Org chart: one manager over three reports, arrows going through a blocking card. */
function orgChart() {
  const boss = { id: "boss", box: box(300, 0) };
  const a = { id: "a", box: box(100, 200) };
  const b = { id: "b", box: box(300, 200) };
  const c = { id: "c", box: box(500, 200) };
  return { boss, a, b, c, all: [boss, a, b, c] };
}

describe("routeArrows", () => {
  it("goes around a shape between the ends", () => {
    const s = { id: "s", box: box(0, 0) };
    const t = { id: "t", box: box(400, 0) };
    const wall = { id: "wall", box: box(200, -40, 60, 140) };
    const obstacles = [s, t, wall];
    const r = routeArrows(obstacles, [req("x", s, t)]).get("x")!;
    expect(r).toBeTruthy();
    expectOrthogonal(r.points);
    expectClear(r.points, obstacles, ["s", "t"]);
  });

  it("never crosses the arrow's own shapes", () => {
    const s = { id: "s", box: box(0, 0) };
    const t = { id: "t", box: box(0, 200) };
    // Only the far sides are allowed: the path must wrap around both shapes.
    const r = routeArrows([s, t], [req("x", s, t, ["n"], ["s"])]).get("x")!;
    expect(r.startSide).toBe("n");
    expect(r.endSide).toBe("s");
    expectOrthogonal(r.points);
    expect(pathCrossesBox(r.points, s.box)).toBe(false);
    expect(pathCrossesBox(r.points, t.box)).toBe(false);
  });

  it("respects pinned sides and picks short straight routes otherwise", () => {
    const s = { id: "s", box: box(0, 0) };
    const t = { id: "t", box: box(300, 0) };
    const free = routeArrows([s, t], [req("x", s, t)]).get("x")!;
    expect([free.startSide, free.endSide]).toEqual(["e", "w"]);
    expect(free.points).toHaveLength(2);
    const pinned = routeArrows([s, t], [req("x", s, t, ["s"], ALL)]).get("x")!;
    expect(pinned.startSide).toBe("s");
  });

  it("shares a trunk for arrows leaving the same shape (org chart bus)", () => {
    const { boss, a, b, c, all } = orgChart();
    // A card between the rows that the naive routes would go through.
    const blocker = { id: "blocker", box: box(140, 100, 60, 40) };
    const obstacles = [...all, blocker];
    const routes = routeArrows(obstacles, [
      req("ba", boss, a, ["s"], ["n"]),
      req("bb", boss, b, ["s"], ["n"]),
      req("bc", boss, c, ["s"], ["n"]),
    ]);
    for (const [id, r] of routes) {
      expect(r, id).toBeTruthy();
      expectOrthogonal(r!.points);
      expectClear(r!.points, obstacles, ["boss", id.slice(1)]);
    }
    // All three run down one vertical trunk; the outer two branch off one horizontal bus.
    for (const r of routes.values()) expect(r!.points[0]).toEqual([350, 65]);
    for (const r of routes.values()) expect(r!.points[1][0]).toBe(350);
    const busY = (id: string) => routes.get(id)!.points[1][1];
    expect(busY("ba")).toBe(busY("bc"));
    expect(routes.get("bb")!.points).toHaveLength(2);
  });

  it("treats a group or frame as one obstacle unless an end is inside it", () => {
    const s = { id: "s", box: box(0, 0) };
    const t = { id: "t", box: box(500, 0) };
    const frame = { id: "frame", box: box(200, -100, 160, 260) };
    const r = routeArrows([s, t, frame], [req("x", s, t)]).get("x")!;
    expect(pathCrossesBox(r.points, frame.box)).toBe(false);

    // End inside the frame: the frame is ignored, its other members become obstacles.
    const inner = { id: "inner", box: box(220, 0, 60, 60) };
    const other = { id: "other", box: box(100, -20, 60, 100) };
    const request: RouteRequest = {
      ...req("y", s, inner),
      ignore: new Set(["frame"]),
      extra: [other],
    };
    const r2 = routeArrows([s, frame], [request]).get("y")!;
    expect(r2).toBeTruthy();
    expect(pathCrossesBox(r2.points, other.box)).toBe(false);
  });

  it("reports an arrow it can't route", () => {
    const s = { id: "s", box: box(0, 0) };
    const t = { id: "t", box: box(400, 0) };
    // Walls on all sides of t, touching its ports.
    const walls = [
      { id: "n", box: box(380, -40, 140, 35) },
      { id: "s2", box: box(380, 65, 140, 35) },
      { id: "w", box: box(380, -40, 15, 140) },
      { id: "e", box: box(505, -40, 15, 140) },
    ];
    const r = routeArrows([s, t, ...walls], [req("x", s, t)]);
    expect(r.get("x")).toBeNull();
  });

  it("is deterministic", () => {
    const { boss, a, b, c, all } = orgChart();
    const requests = [req("ba", boss, a), req("bb", boss, b), req("bc", boss, c)];
    const one = routeArrows(all, requests);
    const two = routeArrows(all, [...requests].reverse());
    for (const id of ["ba", "bb", "bc"]) expect(two.get(id)).toEqual(one.get(id));
  });

  it("routes a few hundred shapes quickly", () => {
    const shapes: Obstacle[] = [];
    for (let row = 0; row < 15; row++) {
      for (let col = 0; col < 20; col++) {
        shapes.push({ id: `n${row}-${col}`, box: box(col * 180, row * 140) });
      }
    }
    const requests: RouteRequest[] = [];
    for (let i = 0; i < 300; i++) {
      const from = shapes[(i * 7) % shapes.length];
      const to = shapes[(i * 13 + 21) % shapes.length];
      if (from !== to) requests.push(req(`r${i}`, from, to));
    }
    const t0 = performance.now();
    const routes = routeArrows(shapes, requests);
    const ms = performance.now() - t0;
    let routed = 0;
    for (const r of requests) {
      const route = routes.get(r.id);
      if (!route) continue;
      routed++;
      expectClear(route.points, shapes, [r.start.key, r.end.key]);
    }
    expect(routed).toBe(requests.length);
    expect(ms).toBeLessThan(3000);
  });
});
