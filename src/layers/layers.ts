/**
 * Layers model: a frames → groups → elements tree over the live scene, plus the rename / lock
 * patches the Layers tab and the `list_layers` / `update_layer` agent tools apply.
 *
 * Names are stored per plan D-DX2 in a prefixed sibling key of `customData`
 * (`customData["excalidrawDesktop.layer"]`), so stock Excalidraw keeps them on round-trip and
 * ignores them. Frames use their native `name`. A group has no element of its own, so its name
 * is written on every member (`groups[groupId]`) and read back from any member.
 */
import type { Draft, El } from "../agent/scene/draft";
import { ToolError } from "../agent/scene/draft";

export const LAYER_KEY = "excalidrawDesktop.layer";

export interface LayerData {
  v: 1;
  /** Custom name for the element itself. */
  name?: string;
  /** Custom names of the groups this element belongs to, keyed by groupId. */
  groups?: Record<string, string>;
}

export type LayerKind = "frame" | "group" | "element";

export interface LayerNode {
  /** Element id, or groupId for groups. */
  id: string;
  kind: LayerKind;
  /** Element type (`rectangle`, `frame`, …) or `"group"`. */
  type: string;
  /** What the tree shows: custom name, frame name, text, bound label, or type. */
  label: string;
  /** The user-set name, if any. */
  name?: string;
  /** True when every element under the node is locked (a frame: the frame itself). */
  locked: boolean;
  /** All element ids the node stands for (a group's members, a frame and its children). */
  elementIds: string[];
  children: LayerNode[];
}

const MAX_LABEL = 40;

const isFrameType = (type: string) => type === "frame" || type === "magicframe";

function layerData(el: El): LayerData | undefined {
  const raw = (el.customData as Record<string, unknown> | undefined)?.[LAYER_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  return raw as LayerData;
}

export function elementName(el: El): string | undefined {
  if (isFrameType(el.type)) return (el as El & { name: string | null }).name || undefined;
  const n = layerData(el)?.name;
  return typeof n === "string" && n ? n : undefined;
}

export function groupName(members: readonly El[], groupId: string): string | undefined {
  for (const el of members) {
    const n = layerData(el)?.groups?.[groupId];
    if (typeof n === "string" && n) return n;
  }
  return undefined;
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_LABEL ? `${one.slice(0, MAX_LABEL - 1)}…` : one;
}

function typeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Build the layer tree, topmost first (reverse z-order, like a design tool's layer list). */
export function buildLayerTree(elements: readonly El[]): LayerNode[] {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));

  // Bound text is shown as its container's label, not as its own row.
  const boundText = new Map<string, El & { text: string }>();
  for (const el of live) {
    if (el.type !== "text") continue;
    const cid = (el as El & { containerId: string | null }).containerId;
    if (cid && byId.has(cid)) boundText.set(cid, el as El & { text: string });
  }
  const folded = new Set([...boundText.values()].map((t) => t.id));

  const leaf = (el: El): LayerNode => {
    const name = elementName(el);
    const bound = boundText.get(el.id);
    const text = el.type === "text" ? (el as El & { text: string }).text : bound?.text;
    return {
      id: el.id,
      kind: isFrameType(el.type) ? "frame" : "element",
      type: el.type,
      label: clip(name ?? text ?? "") || typeLabel(el.type),
      ...(name ? { name } : {}),
      locked: el.locked,
      elementIds: bound ? [el.id, bound.id] : [el.id],
      children: [],
    };
  };

  // Nest groups inside a scope (top level or one frame). `groupIds` runs innermost → outermost.
  const nest = (scoped: readonly El[]): LayerNode[] => {
    const roots: LayerNode[] = [];
    const groups = new Map<string, LayerNode>();
    const members = new Map<string, El[]>();
    for (const el of scoped) {
      for (const g of el.groupIds) {
        const list = members.get(g);
        if (list) list.push(el);
        else members.set(g, [el]);
      }
    }
    // Walk topmost first so children come out in reverse z-order too.
    for (let i = scoped.length - 1; i >= 0; i--) {
      const el = scoped[i];
      if (folded.has(el.id)) continue;
      let child = leaf(el);
      let attached = false;
      for (const g of el.groupIds) {
        const existing = groups.get(g);
        if (existing) {
          existing.children.push(child);
          attached = true;
          break;
        }
        const name = groupName(members.get(g) ?? [], g);
        const node: LayerNode = {
          id: g,
          kind: "group",
          type: "group",
          label: clip(name ?? "") || "Group",
          ...(name ? { name } : {}),
          locked: false,
          elementIds: [],
          children: [child],
        };
        groups.set(g, node);
        child = node;
      }
      if (!attached) roots.push(child);
    }
    for (const [g, node] of groups) {
      const list = members.get(g) ?? [];
      node.elementIds = list.map((e) => e.id);
      node.locked = list.length > 0 && list.every((m) => m.locked);
    }
    return roots;
  };

  const frameChildren = new Map<string, El[]>();
  const topLevel: El[] = [];
  for (const el of live) {
    const fid = el.frameId;
    if (fid && byId.has(fid) && !isFrameType(el.type)) {
      const list = frameChildren.get(fid);
      if (list) list.push(el);
      else frameChildren.set(fid, [el]);
    } else {
      topLevel.push(el);
    }
  }

  const frames: LayerNode[] = [];
  for (let i = topLevel.length - 1; i >= 0; i--) {
    const el = topLevel[i];
    if (!isFrameType(el.type)) continue;
    const node = leaf(el);
    const kids = frameChildren.get(el.id) ?? [];
    node.children = nest(kids);
    node.elementIds = [el.id, ...kids.map((k) => k.id)];
    frames.push(node);
  }
  return [...frames, ...nest(topLevel.filter((e) => !isFrameType(e.type)))];
}

export function findLayer(tree: readonly LayerNode[], id: string): LayerNode | undefined {
  for (const n of tree) {
    if (n.id === id) return n;
    const hit = findLayer(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/** One row per node, for the agent. */
export interface LayerRow {
  id: string;
  kind: LayerKind;
  type: string;
  label: string;
  name?: string;
  locked: boolean;
  depth: number;
  parent?: string;
  elementCount: number;
}

export function flattenLayers(tree: readonly LayerNode[]): LayerRow[] {
  const out: LayerRow[] = [];
  const walk = (nodes: readonly LayerNode[], depth: number, parent?: string) => {
    for (const n of nodes) {
      out.push({
        id: n.id,
        kind: n.kind,
        type: n.type,
        label: n.label,
        ...(n.name ? { name: n.name } : {}),
        locked: n.locked,
        depth,
        ...(parent ? { parent } : {}),
        elementCount: n.elementIds.length,
      });
      walk(n.children, depth + 1, n.id);
    }
  };
  walk(tree, 0);
  return out;
}

// --- edits -------------------------------------------------------------------

function withLayerData(el: El, mutate: (d: LayerData) => void): Record<string, unknown> {
  const prev = layerData(el);
  const next: LayerData = { ...prev, v: 1 };
  if (prev?.groups) next.groups = { ...prev.groups };
  mutate(next);
  if (next.groups && Object.keys(next.groups).length === 0) delete next.groups;
  const custom: Record<string, unknown> = { ...(el.customData ?? {}) };
  if (next.name === undefined && next.groups === undefined) delete custom[LAYER_KEY];
  else custom[LAYER_KEY] = next;
  return custom;
}

function normName(name: string): string | undefined {
  const t = name.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 200) : undefined;
}

/**
 * Rename and/or lock a layer by element id or groupId. An empty name clears the custom name.
 * Frames rename via their native `name`; a frame lock toggles only the frame (as in Excalidraw).
 * Returns the kind that was edited; throws ToolError for an unknown id.
 */
export function applyLayerEdit(
  draft: Draft,
  id: string,
  edit: { name?: string; locked?: boolean },
): LayerKind {
  const el = draft.get(id);
  if (el) {
    const isFrame = isFrameType(el.type);
    if (edit.name !== undefined) {
      const name = normName(edit.name);
      if (isFrame) draft.update(id, { name: name ?? null });
      else {
        const customData = withLayerData(el, (d) => {
          if (name) d.name = name;
          else delete d.name;
        });
        draft.update(id, { customData });
      }
    }
    if (edit.locked !== undefined) {
      draft.update(id, { locked: edit.locked });
      const text = draft.boundTextOf(el);
      if (text) draft.update(text.id, { locked: edit.locked });
    }
    return isFrame ? "frame" : "element";
  }
  const members = draft.live().filter((e) => e.groupIds.includes(id));
  if (members.length === 0) throw new ToolError(`No element or group with id "${id}"`);
  const name = edit.name !== undefined ? normName(edit.name) : undefined;
  for (const m of members) {
    const patch: Record<string, unknown> = {};
    if (edit.name !== undefined) {
      patch.customData = withLayerData(m, (d) => {
        d.groups = d.groups ?? {};
        if (name) d.groups[id] = name;
        else delete d.groups[id];
      });
    }
    if (edit.locked !== undefined) patch.locked = edit.locked;
    draft.update(m.id, patch);
  }
  return "group";
}
