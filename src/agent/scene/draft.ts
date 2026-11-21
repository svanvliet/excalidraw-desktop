/**
 * In-memory working copy of a scene for one agent edit (or one `apply_ops` batch).
 *
 * Every change goes through `newElementWith` (bumps `version`/`versionNonce`, so collab
 * reconciliation and the undo store see it). Nothing reaches Excalidraw until the caller
 * commits `toArray()` — that's what makes `apply_ops` atomic: if any op throws, the draft is
 * simply dropped.
 */
import { newElementWith, hashElementsVersion } from "@excalidraw/excalidraw";
import { anchorPoint, isElbowArrow, sideOf } from "../../lib/elbowAnchors";
import type {
  BoundElement,
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  PointBinding,
} from "@excalidraw/excalidraw/element/types";

export type El = ExcalidrawElement;
export type LinearEl = ExcalidrawLinearElement;
export type TextEl = ExcalidrawTextElement;
type Updates = Record<string, unknown>;

/** Errors the model should see verbatim (bad ids, conflicts, validation). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function revisionOf(elements: readonly El[]): string {
  return String(hashElementsVersion(elements));
}

let idCounter = 0;
/** Ids for agent-created elements/groups (url-safe, unique enough for a scene). */
export function newId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

export function isLinear(el: El): el is LinearEl {
  return el.type === "arrow" || el.type === "line";
}

export function isText(el: El): el is TextEl {
  return el.type === "text";
}

export const BINDABLE_TYPES: ReadonlySet<string> = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "text",
  "image",
  "iframe",
  "embeddable",
  "frame",
  "magicframe",
]);

export class Draft {
  private order: string[];
  private map: Map<string, El>;
  readonly original: ReadonlyMap<string, El>;
  readonly changed = new Set<string>();
  /**
   * Elbow arrows whose route must be recomputed by Excalidraw once they are live (see
   * commitDraft): the router only works on elements mapped into a Scene.
   */
  readonly reroute = new Set<string>();

  constructor(elements: readonly El[]) {
    this.order = elements.map((e) => e.id);
    this.map = new Map(elements.map((e) => [e.id, e]));
    this.original = new Map(this.map);
  }

  /** Any element, including tombstones. */
  peek(id: string): El | undefined {
    return this.map.get(id);
  }

  /** A live (non-deleted) element or undefined. */
  get(id: string): El | undefined {
    const el = this.map.get(id);
    return el && !el.isDeleted ? el : undefined;
  }

  mustGet(id: unknown): El {
    if (typeof id !== "string") {
      throw new ToolError(`Expected an element id string, got ${JSON.stringify(id)}`);
    }
    const el = this.get(id);
    if (!el) throw new ToolError(`No element with id "${id}" on this canvas`);
    return el;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  live(): El[] {
    const out: El[] = [];
    for (const id of this.order) {
      const el = this.map.get(id)!;
      if (!el.isDeleted) out.push(el);
    }
    return out;
  }

  toArray(): El[] {
    return this.order.map((id) => this.map.get(id)!);
  }

  revision(): string {
    return revisionOf(this.toArray());
  }

  /** Patch an element through `newElementWith` (version bump). No-op if nothing differs. */
  update<T extends El = El>(id: string, updates: Updates, force = false): T {
    const cur = this.map.get(id);
    if (!cur) throw new ToolError(`No element with id "${id}" on this canvas`);
    const next = newElementWith(cur, updates as never, force);
    if (next !== cur) {
      this.map.set(id, next);
      this.changed.add(id);
    }
    return next as T;
  }

  add(el: El): void {
    if (this.map.has(el.id)) throw new ToolError(`Element id "${el.id}" already exists`);
    this.order.push(el.id);
    this.map.set(el.id, el);
    this.changed.add(el.id);
  }

  /** Move ids (keeping their relative order) to the front (top) or back of the z-order. */
  reorder(ids: ReadonlySet<string>, where: "front" | "back"): void {
    const moved = this.order.filter((id) => ids.has(id));
    const rest = this.order.filter((id) => !ids.has(id));
    this.order = where === "front" ? [...rest, ...moved] : [...moved, ...rest];
    // A null index is "invalid", so updateScene's syncInvalidIndices assigns a fresh one.
    for (const id of moved) this.update(id, { index: null }, true);
  }

  // --- relationships -------------------------------------------------------

  boundTextOf(el: El): TextEl | undefined {
    const ref = el.boundElements?.find((b) => b.type === "text");
    const text = ref ? this.get(ref.id) : undefined;
    if (text && isText(text)) return text;
    // Fall back to scanning in case boundElements is stale.
    for (const e of this.live()) if (isText(e) && e.containerId === el.id) return e;
    return undefined;
  }

  /** Live arrows/lines whose start or end is bound to `id`. */
  arrowsBoundTo(id: string): LinearEl[] {
    return this.live().filter(
      (e): e is LinearEl =>
        isLinear(e) && (e.startBinding?.elementId === id || e.endBinding?.elementId === id),
    );
  }

  addBoundElement(containerId: string, ref: BoundElement): void {
    const c = this.mustGet(containerId);
    const list = c.boundElements ?? [];
    if (list.some((b) => b.id === ref.id)) return;
    this.update(containerId, { boundElements: [...list, ref] });
  }

  /** Bind one end of an arrow to `targetId` and register the arrow on the target. */
  bindArrow(arrowId: string, side: "start" | "end", targetId: string): void {
    const target = this.mustGet(targetId);
    if (!BINDABLE_TYPES.has(target.type)) {
      throw new ToolError(`Element "${targetId}" (${target.type}) can't have arrows bound to it`);
    }
    const binding: PointBinding = { elementId: targetId, focus: 0, gap: 8 };
    this.update(arrowId, side === "start" ? { startBinding: binding } : { endBinding: binding });
    this.addBoundElement(targetId, { id: arrowId, type: "arrow" });
  }
}

// --- geometry --------------------------------------------------------------

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Axis-aligned bounds (rotation ignored — good enough for layout and filtering). */
export function boundsOf(el: El): Box {
  if ((isLinear(el) || el.type === "freedraw") && el.points.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of el.points) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    return { minX: el.x + minX, minY: el.y + minY, maxX: el.x + maxX, maxY: el.y + maxY };
  }
  return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

export function unionBounds(els: readonly El[]): Box | null {
  if (!els.length) return null;
  const b = els.map(boundsOf);
  return {
    minX: Math.min(...b.map((x) => x.minX)),
    minY: Math.min(...b.map((x) => x.minY)),
    maxX: Math.max(...b.map((x) => x.maxX)),
    maxY: Math.max(...b.map((x) => x.maxY)),
  };
}

export function intersects(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function centerOf(el: El): [number, number] {
  return [el.x + el.width / 2, el.y + el.height / 2];
}

/** Point on `el`'s outline in the direction of `toward`, pushed out by `gap`. */
export function edgePoint(el: El, toward: readonly number[], gap: number): [number, number] {
  const [cx, cy] = centerOf(el);
  let dx = toward[0] - cx;
  let dy = toward[1] - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [cx, cy];
  dx /= len;
  dy /= len;
  const hw = Math.max(el.width / 2, 1e-6);
  const hh = Math.max(el.height / 2, 1e-6);
  let t: number;
  if (el.type === "ellipse") t = 1 / Math.hypot(dx / hw, dy / hh);
  else if (el.type === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else {
    t = Math.min(
      Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity,
    );
  }
  return [cx + dx * (t + gap), cy + dy * (t + gap)];
}

/** Position a bound text element inside its container (or at an arrow's midpoint). */
export function placeBoundText(draft: Draft, textId: string): void {
  const text = draft.get(textId);
  if (!text || !isText(text) || !text.containerId) return;
  const c = draft.get(text.containerId);
  if (!c) return;
  const PAD = 5; // Excalidraw's BOUND_TEXT_PADDING
  let x: number;
  let y: number;
  if (isLinear(c)) {
    const pts = c.points;
    let mx = 0;
    let my = 0;
    if (pts.length % 2 === 1) [mx, my] = pts[(pts.length - 1) / 2];
    else if (pts.length) {
      const a = pts[pts.length / 2 - 1];
      const b = pts[pts.length / 2];
      mx = (a[0] + b[0]) / 2;
      my = (a[1] + b[1]) / 2;
    }
    x = c.x + mx - text.width / 2;
    y = c.y + my - text.height / 2;
  } else {
    x =
      text.textAlign === "left"
        ? c.x + PAD
        : text.textAlign === "right"
          ? c.x + c.width - PAD - text.width
          : c.x + (c.width - text.width) / 2;
    y =
      text.verticalAlign === "top"
        ? c.y + PAD
        : text.verticalAlign === "bottom"
          ? c.y + c.height - PAD - text.height
          : c.y + (c.height - text.height) / 2;
  }
  draft.update(textId, { x, y });
}

/**
 * Re-route a bound arrow after its endpoints moved: the first/last points snap to the bound
 * elements' outlines (aimed at the other end); intermediate points keep their absolute
 * position. Excalidraw only does this itself during pointer interactions, so the agent has to.
 */
export function routeArrow(draft: Draft, arrowId: string): void {
  const arrow = draft.get(arrowId);
  if (!arrow || !isLinear(arrow)) return;
  const abs = arrow.points.map(([px, py]) => [arrow.x + px, arrow.y + py] as [number, number]);
  if (abs.length < 2) return;
  const startEl = arrow.startBinding ? draft.get(arrow.startBinding.elementId) : undefined;
  const endEl = arrow.endBinding ? draft.get(arrow.endBinding.elementId) : undefined;
  if (!startEl && !endEl) return;
  const n = abs.length;
  if (isElbowArrow(arrow)) {
    // Placeholder straight route between the pinned points; commitDraft re-routes it for real.
    draft.reroute.add(arrowId);
    const pinned = (b: typeof arrow.startBinding, el: El | undefined) => {
      const side = sideOf(b?.fixedPoint);
      return el && side ? anchorPoint(side, el) : undefined;
    };
    const s = pinned(arrow.startBinding, startEl);
    const e = pinned(arrow.endBinding, endEl);
    if (s) abs[0] = s;
    if (e) abs[n - 1] = e;
    if (s || e) {
      abs.splice(1, n - 2);
      return setArrowPoints(draft, arrowId, abs);
    }
  }
  const startAim = n > 2 ? abs[1] : endEl ? centerOf(endEl) : abs[n - 1];
  const endAim = n > 2 ? abs[n - 2] : startEl ? centerOf(startEl) : abs[0];
  if (startEl) abs[0] = edgePoint(startEl, startAim, arrow.startBinding!.gap);
  if (endEl) abs[n - 1] = edgePoint(endEl, endAim, arrow.endBinding!.gap);
  setArrowPoints(draft, arrowId, abs);
}

function setArrowPoints(draft: Draft, arrowId: string, abs: [number, number][]): void {
  const [ox, oy] = abs[0];
  const points = abs.map(([px, py]) => [px - ox, py - oy]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const next = draft.update(arrowId, {
    x: ox,
    y: oy,
    points,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  });
  const label = draft.boundTextOf(next);
  if (label) placeBoundText(draft, label.id);
}

export function rerouteAround(draft: Draft, ids: Iterable<string>): void {
  const arrows = new Set<string>();
  for (const id of ids) for (const a of draft.arrowsBoundTo(id)) arrows.add(a.id);
  for (const id of arrows) routeArrow(draft, id);
}

/**
 * Translate elements (and their bound text) by [dx, dy], then re-route every arrow bound to
 * anything that moved.
 */
export function moveElements(draft: Draft, moves: ReadonlyMap<string, [number, number]>): void {
  const moved = new Set<string>();
  for (const [id, [dx, dy]] of moves) {
    if (!dx && !dy) continue;
    const el = draft.mustGet(id);
    draft.update(id, { x: el.x + dx, y: el.y + dy });
    moved.add(id);
    const label = draft.boundTextOf(el);
    if (label && !moves.has(label.id)) {
      draft.update(label.id, { x: label.x + dx, y: label.y + dy });
      moved.add(label.id);
    }
  }
  rerouteAround(draft, moved);
}
