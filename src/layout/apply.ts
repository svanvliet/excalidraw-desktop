/**
 * One-shot auto-layout on a {@link Draft}: extract the graph, run ELK, move every node's members
 * (and their bound text) and re-route the arrows so their bindings stay valid. The caller
 * commits the draft — as one undo step (user action) or folded into the agent turn.
 */
import {
  isLinear,
  placeBoundText,
  routeArrow,
  ToolError,
  type Draft,
  type LinearEl,
} from "../agent/scene/draft";
import {
  computeLayout,
  type LayoutAlgorithm,
  type LayoutOptionsIn,
  type LayoutResult,
} from "./elk";
import { extractGraph, layoutTargets, type LayoutDirection, type LayoutGraph } from "./graph";

export type { LayoutAlgorithm, LayoutDirection };

export interface AutoLayoutOptions {
  /** Element ids to lay out; omitted/empty = the whole scene. */
  ids?: readonly string[];
  algorithm?: LayoutAlgorithm;
  direction?: LayoutDirection;
  spacing?: number;
}

export interface AutoLayoutSummary {
  nodes: number;
  edges: number;
  moved: string[];
}

/** Lay out `draft` in place. Throws ToolError when there's nothing to lay out. */
export async function autoLayoutDraft(
  draft: Draft,
  opts: AutoLayoutOptions = {},
): Promise<AutoLayoutSummary> {
  const graph = extractGraph(draft, layoutTargets(draft, opts.ids));
  if (graph.nodes.length < 2) {
    throw new ToolError("Auto-layout needs at least two shapes, groups or frames");
  }
  const orthogonal = graph.edges.some((e) => isElbow(draft.get(e.arrowId)));
  const layoutOpts: LayoutOptionsIn = {
    algorithm: opts.algorithm,
    direction: opts.direction,
    spacing: opts.spacing,
    orthogonal,
  };
  const result = await computeLayout(graph, layoutOpts);
  return applyLayout(draft, graph, result);
}

function isElbow(el: unknown): boolean {
  return !!el && (el as { elbowed?: boolean }).elbowed === true;
}

/**
 * Apply an ELK result: the laid-out graph keeps the original top-left corner, each node's
 * members translate by one delta, edge arrows take ELK's route (snapped to their bound shapes),
 * attached arrows travel with their node, and every other arrow bound to a moved element is
 * re-routed.
 */
export function applyLayout(
  draft: Draft,
  graph: LayoutGraph,
  result: LayoutResult,
): AutoLayoutSummary {
  // ELK pads the root graph; shift so the laid-out nodes start at the original top-left.
  const placed = [...result.nodes.values()];
  const originX =
    Math.min(...graph.nodes.map((n) => n.box.minX)) - Math.min(...placed.map((p) => p.x));
  const originY =
    Math.min(...graph.nodes.map((n) => n.box.minY)) - Math.min(...placed.map((p) => p.y));
  const moved = new Set<string>();
  const delta = new Map<string, [number, number]>();
  for (const node of graph.nodes) {
    const p = result.nodes.get(node.id);
    if (!p) continue;
    const d: [number, number] = [originX + p.x - node.box.minX, originY + p.y - node.box.minY];
    delta.set(node.id, d);
    if (!d[0] && !d[1]) continue;
    for (const id of node.members) {
      translate(draft, id, d);
      moved.add(id);
      const el = draft.get(id);
      const label = el ? draft.boundTextOf(el) : undefined;
      if (label && !node.members.includes(label.id)) {
        translate(draft, label.id, d);
        moved.add(label.id);
      }
    }
  }

  const routed = new Set<string>();
  for (const edge of graph.edges) {
    const arrow = draft.get(edge.arrowId);
    if (!arrow || !isLinear(arrow)) continue;
    const route = result.edges.get(edge.id);
    const abs = route
      ? route.map(([x, y]): [number, number] => [originX + x, originY + y])
      : undefined;
    setArrowRoute(draft, arrow, abs);
    routed.add(arrow.id);
    moved.add(arrow.id);
  }
  for (const [arrowId, nodeId] of graph.attached) {
    const d = delta.get(nodeId);
    if (!d || routed.has(arrowId)) continue;
    translate(draft, arrowId, d);
    routeArrow(draft, arrowId);
    routed.add(arrowId);
    moved.add(arrowId);
  }
  const others = [...moved].filter((id) => !routed.has(id));
  for (const arrow of new Set(others.flatMap((id) => draft.arrowsBoundTo(id)))) {
    if (routed.has(arrow.id)) continue;
    routeArrow(draft, arrow.id);
    routed.add(arrow.id);
    moved.add(arrow.id);
  }
  return { nodes: graph.nodes.length, edges: graph.edges.length, moved: [...moved] };
}

function translate(draft: Draft, id: string, [dx, dy]: [number, number]): void {
  const el = draft.get(id);
  if (el) draft.update(id, { x: el.x + dx, y: el.y + dy });
}

/**
 * Give an edge arrow a fresh route. Ordinary arrows take ELK's polyline and then snap their
 * ends to the bound shapes' outlines (via `routeArrow`), so bindings stay valid even when the
 * node is a group or frame. Elbow arrows keep ELK's orthogonal route as-is.
 */
function setArrowRoute(draft: Draft, arrow: LinearEl, abs?: Array<[number, number]>): void {
  let pts = abs;
  if (!pts || pts.length < 2) {
    // No route from ELK: a straight segment between the bound shapes' centres.
    const s = arrow.startBinding ? draft.get(arrow.startBinding.elementId) : undefined;
    const e = arrow.endBinding ? draft.get(arrow.endBinding.elementId) : undefined;
    if (!s || !e) return;
    pts = [
      [s.x + s.width / 2, s.y + s.height / 2],
      [e.x + e.width / 2, e.y + e.height / 2],
    ];
  }
  const [ox, oy] = pts[0];
  const points = pts.map(([x, y]) => [x - ox, y - oy]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  draft.update(arrow.id, {
    x: ox,
    y: oy,
    points,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    ...(isElbow(arrow) ? { fixedSegments: null } : {}),
  });
  if (isElbow(arrow)) {
    const label = draft.boundTextOf(arrow);
    if (label) placeBoundText(draft, label.id);
  } else {
    routeArrow(draft, arrow.id);
  }
}
