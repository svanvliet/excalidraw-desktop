/**
 * Lazily-loaded ELK (Eclipse Layout Kernel) runner.
 *
 * The app runs ELK's prebuilt worker (`elk-worker.min.js`, no eval) from a same-origin asset,
 * so it works offline under the release CSP (`worker-src 'self' blob:`, no `unsafe-eval`). Both
 * the API and the worker are dynamic imports: the ~1.6 MB worker is only fetched the first time
 * someone lays out a diagram. Tests inject a main-thread engine via {@link setElkFactory}.
 */
import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from "elkjs/lib/elk-api";
import type { LayoutDirection, LayoutGraph } from "./graph";
import { sortNodes } from "./graph";

export type LayoutAlgorithm = "layered" | "tree";

export interface LayoutOptionsIn {
  algorithm?: LayoutAlgorithm;
  direction?: LayoutDirection;
  /** Gap between nodes, in scene px (also used between layers/levels). */
  spacing?: number;
  /** Route edges orthogonally (set when any edge is an elbow arrow). */
  orthogonal?: boolean;
}

export const DEFAULT_SPACING = 60;

export interface NodePlacement {
  x: number;
  y: number;
}

export interface LayoutResult {
  nodes: Map<string, NodePlacement>;
  /** Edge id → polyline (start, bends…, end) in layout coordinates. */
  edges: Map<string, Array<[number, number]>>;
}

let factory: (() => Promise<ELK>) | null = null;
let instance: Promise<ELK> | null = null;

/** Replace how the ELK engine is created (tests use the main-thread `elk.bundled.js`). */
export function setElkFactory(f: (() => Promise<ELK>) | null): void {
  factory = f;
  instance = null;
}

async function workerElk(): Promise<ELK> {
  const [{ default: ElkApi }, { default: workerUrl }] = await Promise.all([
    import("elkjs/lib/elk-api.js"),
    import("elkjs/lib/elk-worker.min.js?url"),
  ]);
  return new ElkApi({ workerUrl });
}

function elk(): Promise<ELK> {
  if (!instance) {
    instance = (factory ?? workerElk)();
    instance.catch(() => (instance = null));
  }
  return instance;
}

const ELK_DIRECTION: Record<LayoutDirection, string> = {
  down: "DOWN",
  up: "UP",
  right: "RIGHT",
  left: "LEFT",
};

export function elkOptions(opts: LayoutOptionsIn): LayoutOptions {
  const spacing = String(opts.spacing ?? DEFAULT_SPACING);
  const direction = ELK_DIRECTION[opts.direction ?? "down"];
  if (opts.algorithm === "tree") {
    return {
      "elk.algorithm": "mrtree",
      "elk.direction": direction,
      "elk.spacing.nodeNode": spacing,
      "elk.mrtree.weighting": "MODEL_ORDER",
    };
  }
  return {
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.spacing.nodeNode": spacing,
    "elk.layered.spacing.nodeNodeBetweenLayers": spacing,
    "elk.spacing.componentComponent": spacing,
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.edgeRouting": opts.orthogonal ? "ORTHOGONAL" : "POLYLINE",
  };
}

/** The ELK input graph for `graph` (exported for tests). */
export function toElkGraph(graph: LayoutGraph, opts: LayoutOptionsIn): ElkNode {
  const nodes = [...graph.nodes];
  sortNodes(nodes, opts.direction ?? "down");
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = [...graph.edges].sort(
    (a, b) =>
      order.get(a.source)! - order.get(b.source)! || order.get(a.target)! - order.get(b.target)!,
  );
  return {
    id: "root",
    layoutOptions: elkOptions(opts),
    children: nodes.map((n) => ({
      id: n.id,
      width: Math.max(1, n.box.maxX - n.box.minX),
      height: Math.max(1, n.box.maxY - n.box.minY),
    })),
    edges: edges.map(
      (e): ElkExtendedEdge => ({ id: e.id, sources: [e.source], targets: [e.target] }),
    ),
  };
}

/** Run ELK on `graph`. Positions are relative to the layout's own origin. */
export async function computeLayout(
  graph: LayoutGraph,
  opts: LayoutOptionsIn,
): Promise<LayoutResult> {
  const engine = await elk();
  const out = await engine.layout(toElkGraph(graph, opts));
  const nodes = new Map<string, NodePlacement>();
  for (const c of out.children ?? []) nodes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  const edges = new Map<string, Array<[number, number]>>();
  for (const e of (out.edges ?? []) as ElkExtendedEdge[]) {
    const s = e.sections?.[0];
    if (!s) continue;
    edges.set(e.id, [
      [s.startPoint.x, s.startPoint.y],
      ...(s.bendPoints ?? []).map((p): [number, number] => [p.x, p.y]),
      [s.endPoint.x, s.endPoint.y],
    ]);
  }
  return { nodes, edges };
}
