/**
 * "Tidy Arrows" (FR-60, docs/plan.md D-DX14): re-route bound elbow arrows around the other
 * shapes without moving anything. Shapes, groups, frames and components are obstacles exactly as
 * auto-layout sees them (graph.ts nodes); arrows from one shape share a trunk; ends pinned to a
 * side (D-DX8 anchors) keep their side; the others take whichever side routes best and are
 * pinned to it, since Excalidraw drops an elbow binding without a fixedPoint on load.
 *
 * The route is written as the arrow's points plus `fixedSegments` for every interior segment,
 * which is what Excalidraw 0.18.1 keeps when a bound shape later moves (see D-DX14): only the
 * first and last segments are rebuilt to meet the moved ends. The caller commits the draft.
 */
import {
  boundsOf,
  isLinear,
  placeBoundText,
  ToolError,
  unionBounds,
  type Box,
  type Draft,
  type El,
  type LinearEl,
} from "../agent/scene/draft";
import { anchorPoint, fixedPointFor, sideOf, SIDES } from "../lib/elbowAnchors";
import { activePin, hasPin, PIN_KEY } from "../lib/lineAnchors";
import { log } from "../lib/logger";
import { extractGraph, layoutTargets } from "./graph";
import { routeArrows, type Obstacle, type Port, type RouteEnd, type RouteRequest } from "./route";

export interface TidyOptions {
  /** Arrows (or shapes, whose arrows are tidied) to work on; omitted/empty = every arrow. */
  ids?: readonly string[];
  /** Convert bound non-elbow arrows to elbow arrows first (off by default). */
  convert?: boolean;
}

export interface TidySummary {
  routed: string[];
  /** Arrows the router couldn't fit between the shapes; left as they were. */
  skipped: string[];
  converted: string[];
}

type Binding = NonNullable<LinearEl["startBinding"]>;

const isFrame = (el: El) => el.type === "frame" || el.type === "magicframe";
const isElbow = (el: El) => (el as { elbowed?: boolean }).elbowed === true;

/**
 * Route the elbow arrows auto-layout left for Excalidraw around the other shapes too (keeping
 * the along-flow sides it pinned). Any the router can't fit stay on Excalidraw's re-route.
 */
export function tidyAfterLayout(draft: Draft): void {
  const ids = [...draft.reroute].filter((id) => {
    const el = draft.get(id);
    return !!el && isElbow(el);
  });
  if (!ids.length) return;
  try {
    tidyArrowsDraft(draft, { ids });
  } catch (err) {
    if (!(err instanceof ToolError)) log.warn("auto-layout: tidying elbow arrows failed", err);
  }
}

/** Tidy the arrows in `draft` in place. Throws ToolError when there's nothing to tidy. */
export function tidyArrowsDraft(draft: Draft, opts: TidyOptions = {}): TidySummary {
  const arrows = candidates(draft, opts);
  if (!arrows.length) {
    throw new ToolError(
      opts.convert
        ? "No arrows bound at both ends to tidy"
        : "No elbow arrows bound at both ends to tidy (convert straight arrows to include them)",
    );
  }
  const graph = extractGraph(draft, draft.live());
  const obstacles: Obstacle[] = graph.nodes.map((n) => ({ id: n.id, box: n.box }));
  const membersOf = new Map(graph.nodes.map((n) => [n.id, n.members]));

  const sides = endSides(draft, arrows);
  const requests: RouteRequest[] = [];
  for (const arrow of arrows) {
    const s = draft.get(arrow.startBinding!.elementId)!;
    const e = draft.get(arrow.endBinding!.elementId)!;
    const ignore = new Set<string>();
    const extra: Obstacle[] = [];
    // An end inside a group or frame: route among that node's other members instead.
    for (const end of [s, e]) {
      const node = graph.nodeOf.get(end.id);
      if (!node || node === end.id || ignore.has(node)) continue;
      ignore.add(node);
      for (const id of membersOf.get(node) ?? []) {
        const m = draft.get(id);
        if (!m || m.id === s.id || m.id === e.id || isFrame(m)) continue;
        const label = draft.boundTextOf(m);
        extra.push({ id: m.id, box: unionBounds(label ? [m, label] : [m])! });
      }
    }
    requests.push({
      id: arrow.id,
      start: routeEnd(s, sides.get(`s:${arrow.id}`)),
      end: routeEnd(e, sides.get(`e:${arrow.id}`)),
      ignore,
      extra,
    });
  }

  const routes = routeArrows(obstacles, requests);
  const summary: TidySummary = { routed: [], skipped: [], converted: [] };
  for (const arrow of arrows) {
    const route = routes.get(arrow.id);
    if (!route) {
      summary.skipped.push(arrow.id);
      continue;
    }
    if (!isElbow(arrow)) summary.converted.push(arrow.id);
    const s = draft.get(arrow.startBinding!.elementId)!;
    const e = draft.get(arrow.endBinding!.elementId)!;
    const [ox, oy] = route.points[0];
    const points = route.points.map(([x, y]) => [x - ox, y - oy] as [number, number]);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const pin = (b: Binding, el: El, side: Side): Binding =>
      ({
        ...b,
        fixedPoint: fixedPointFor(side, el),
      }) as Binding;
    const next = draft.update(arrow.id, {
      elbowed: true,
      roundness: null,
      x: ox,
      y: oy,
      points,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      startBinding: pin(arrow.startBinding!, s, route.startSide),
      endBinding: pin(arrow.endBinding!, e, route.endSide),
      fixedSegments: fixedSegmentsFor(points),
      startIsSpecial: false,
      endIsSpecial: false,
      // An elbow arrow pins by fixedPoint; drop the straight-arrow pin it was converted from.
      ...(hasPin(arrow) ? { customData: withoutPin(arrow.customData) } : {}),
    } as Partial<LinearEl>);
    // Written as-is: Excalidraw re-routing it on commit would throw the route away.
    draft.reroute.delete(arrow.id);
    const label = draft.boundTextOf(next);
    if (label) placeBoundText(draft, label.id);
    summary.routed.push(arrow.id);
  }
  return summary;
}

function withoutPin(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const { [PIN_KEY]: _pin, ...rest } = data ?? {};
  void _pin;
  return rest;
}

/** Arrows to tidy: bound at both ends to two different unrotated shapes. */
function candidates(draft: Draft, opts: TidyOptions): LinearEl[] {
  const pool = new Map<string, LinearEl>();
  if (!opts.ids?.length) {
    for (const el of draft.live()) if (isLinear(el)) pool.set(el.id, el);
  } else {
    for (const el of layoutTargets(draft, opts.ids)) {
      if (isLinear(el)) pool.set(el.id, el);
      for (const a of draft.arrowsBoundTo(el.id)) pool.set(a.id, a);
    }
  }
  return [...pool.values()].filter((a) => {
    if (a.type !== "arrow" || (!isElbow(a) && !opts.convert)) return false;
    const s = a.startBinding && draft.get(a.startBinding.elementId);
    const e = a.endBinding && draft.get(a.endBinding.elementId);
    return !!s && !!e && s.id !== e.id && !s.angle && !e.angle;
  });
}

type Side = (typeof SIDES)[number];
const OPPOSITE: Record<Side, Side> = { n: "s", s: "n", e: "w", w: "e" };
const centre = (el: El): [number, number] => [el.x + el.width / 2, el.y + el.height / 2];

/**
 * The side each arrow end must use (`s:<id>` / `e:<id>`), or none to let the router choose.
 * Pinned ends keep their side. A shape that several unpinned arrows leave (or enter) gets one
 * side for all of them, facing the other ends on average, so they can share a bus; their far
 * ends, if free and lying that way, face back along the same axis (org-chart style).
 */
function endSides(draft: Draft, arrows: readonly LinearEl[]): Map<string, Side> {
  const out = new Map<string, Side>();
  // Straight/curved arrows being converted keep a face-centre pin (D-DX15) as their side.
  const pinnedSide = (a: LinearEl, end: "start" | "end"): Side | null => {
    if (isElbow(a))
      return sideOf((a[`${end}Binding`] as { fixedPoint?: [number, number] }).fixedPoint);
    const anchor = activePin(a as never, end)?.anchor;
    return anchor && anchor !== "center" ? anchor : null;
  };
  for (const a of arrows) {
    const ps = pinnedSide(a, "start");
    const pe = pinnedSide(a, "end");
    if (ps) out.set(`s:${a.id}`, ps);
    if (pe) out.set(`e:${a.id}`, pe);
  }
  for (const [near, far] of [
    ["s", "e"],
    ["e", "s"],
  ] as const) {
    const fans = new Map<string, LinearEl[]>();
    for (const a of arrows) {
      if (out.has(`${near}:${a.id}`)) continue;
      const id = (near === "s" ? a.startBinding : a.endBinding)!.elementId;
      fans.set(id, [...(fans.get(id) ?? []), a]);
    }
    for (const [id, fan] of fans) {
      if (fan.length < 2) continue;
      const hub = draft.get(id)!;
      const [hx, hy] = centre(hub);
      let dx = 0;
      let dy = 0;
      const others = fan.map(
        (a) => draft.get((near === "s" ? a.endBinding : a.startBinding)!.elementId)!,
      );
      for (const o of others) {
        const [ox, oy] = centre(o);
        dx += ox - hx;
        dy += oy - hy;
      }
      const side: Side = Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? "s" : "n") : dx >= 0 ? "e" : "w";
      fan.forEach((a, i) => {
        out.set(`${near}:${a.id}`, side);
        const farKey = `${far}:${a.id}`;
        if (!out.has(farKey) && beyond(hub, others[i], side)) out.set(farKey, OPPOSITE[side]);
      });
    }
  }
  return out;
}

/** `o` lies wholly past `hub`'s `side`. */
function beyond(hub: El, o: El, side: Side): boolean {
  switch (side) {
    case "s":
      return o.y >= hub.y + hub.height;
    case "n":
      return o.y + o.height <= hub.y;
    case "e":
      return o.x >= hub.x + hub.width;
    case "w":
      return o.x + o.width <= hub.x;
  }
}

function routeEnd(el: El, pinned: Side | undefined): RouteEnd {
  const ports: Port[] = (pinned ? [pinned] : SIDES).map((side) => ({
    side,
    point: anchorPoint(side, el),
  }));
  const box: Box = boundsOf(el);
  return { key: el.id, box, ports };
}

/**
 * Pin every interior segment so a later move of a bound shape keeps the route. Segment `index`
 * runs from points[index - 1] to points[index]; the first and last stay free so Excalidraw can
 * rebuild them to meet the moved ends.
 */
export function fixedSegmentsFor(
  points: readonly [number, number][],
): Array<{ index: number; start: [number, number]; end: [number, number] }> | null {
  if (points.length < 4) return null;
  const out = [];
  for (let i = 2; i <= points.length - 2; i++) {
    out.push({ index: i, start: points[i - 1], end: points[i] });
  }
  return out;
}
