/**
 * Graph extraction for auto-layout: turns a scene (or a subset) into layout nodes and edges.
 *
 * - A node is one movable unit: a lone shape, an outermost group, or a frame plus its children.
 *   Bound text never becomes a node; it moves with its container.
 * - Arrows bound at both ends to two different nodes become edges. An arrow bound at one end
 *   only is "attached" to that node and travels with it; every other bound arrow is re-routed.
 * - Unbound lines/arrows are ordinary nodes (they're drawings, not connectors).
 */
import { isLinear, isText, unionBounds, type Box, type Draft, type El } from "../agent/scene/draft";

export type LayoutDirection = "down" | "up" | "right" | "left";

export interface LayoutNode {
  id: string;
  /** Element ids moved as one unit (bound text excluded; it follows its container). */
  members: string[];
  /** Bounds of the members and their bound text. */
  box: Box;
}

export interface LayoutEdge {
  id: string;
  /** The arrow element this edge comes from. */
  arrowId: string;
  source: string;
  target: string;
}

export interface LayoutGraph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** Arrow id → node id, for arrows bound at exactly one end (the other end is free). */
  attached: Map<string, string>;
  /** Element id → node id for every element a node moves (bound text included). */
  nodeOf: Map<string, string>;
}

const isFrame = (el: El) => el.type === "frame" || el.type === "magicframe";
const hasBinding = (el: El) => isLinear(el) && !!(el.startBinding || el.endBinding);

/**
 * Elements to lay out: `ids` expanded to whole groups, frame children and bound text, or every
 * live element when `ids` is empty or omitted.
 */
export function layoutTargets(draft: Draft, ids?: readonly string[]): El[] {
  const live = draft.live();
  if (!ids?.length) return live;
  const want = new Set<string>();
  const groups = new Set<string>();
  const frames = new Set<string>();
  for (const id of ids) {
    const el = draft.mustGet(id);
    want.add(el.id);
    const outer = el.groupIds[el.groupIds.length - 1];
    if (outer) groups.add(outer);
    if (isFrame(el)) frames.add(el.id);
    if (isText(el) && el.containerId) want.add(el.containerId);
  }
  for (const el of live) {
    if (el.groupIds.some((g) => groups.has(g))) want.add(el.id);
    if (el.frameId && frames.has(el.frameId)) want.add(el.id);
  }
  for (const el of live) {
    if (isText(el) && el.containerId && want.has(el.containerId)) want.add(el.id);
  }
  return live.filter((el) => want.has(el.id));
}

/** Build the layout graph for `targets` (see {@link layoutTargets}). */
export function extractGraph(draft: Draft, targets: readonly El[]): LayoutGraph {
  const targetIds = new Set(targets.map((e) => e.id));
  const frameIds = new Set(targets.filter(isFrame).map((e) => e.id));
  const keyOf = (el: El): string => {
    if (frameIds.has(el.id)) return el.id;
    if (el.frameId && frameIds.has(el.frameId)) return el.frameId;
    const outer = el.groupIds[el.groupIds.length - 1];
    return outer ? `group:${outer}` : el.id;
  };

  const members = new Map<string, El[]>();
  const nodeOf = new Map<string, string>();
  for (const el of targets) {
    if (isText(el) && el.containerId && targetIds.has(el.containerId)) continue;
    if (hasBinding(el)) continue;
    const key = keyOf(el);
    let list = members.get(key);
    if (!list) members.set(key, (list = []));
    list.push(el);
    nodeOf.set(el.id, key);
  }
  for (const el of targets) {
    if (isText(el) && el.containerId) {
      const owner = nodeOf.get(el.containerId);
      if (owner) nodeOf.set(el.id, owner);
    }
  }

  const nodes: LayoutNode[] = [];
  for (const [id, els] of members) {
    const withText = els.flatMap((e) => {
      const t = draft.boundTextOf(e);
      return t ? [e, t] : [e];
    });
    nodes.push({ id, members: els.map((e) => e.id), box: unionBounds(withText)! });
  }

  const edges: LayoutEdge[] = [];
  const attached = new Map<string, string>();
  for (const el of draft.live()) {
    if (!isLinear(el) || !hasBinding(el)) continue;
    const s = el.startBinding ? nodeOf.get(el.startBinding.elementId) : undefined;
    const t = el.endBinding ? nodeOf.get(el.endBinding.elementId) : undefined;
    if (s && t && s !== t) edges.push({ id: `e:${el.id}`, arrowId: el.id, source: s, target: t });
    else if (s && !el.endBinding) attached.set(el.id, s);
    else if (t && !el.startBinding) attached.set(el.id, t);
  }
  return { nodes, edges, attached, nodeOf };
}

/**
 * Order nodes across the flow (left→right for vertical layouts, top→bottom for horizontal
 * ones) so ELK's model-order tie-breaking keeps siblings in their current visual order.
 */
export function sortNodes(nodes: LayoutNode[], direction: LayoutDirection): void {
  const vertical = direction === "down" || direction === "up";
  nodes.sort((a, b) =>
    vertical
      ? a.box.minX - b.box.minX || a.box.minY - b.box.minY
      : a.box.minY - b.box.minY || a.box.minX - b.box.minX,
  );
}
