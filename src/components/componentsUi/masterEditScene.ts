/**
 * Scene for the master-edit overlay (FR-66, D-DX20) and the step that applies it back.
 *
 * `buildMasterEditScene` rebuilds the component's master off the main scene (`masterSnapshot`,
 * never committed), puts it where the instance being edited is, and adds dimmed, locked copies
 * of the drawing around it for context. `editedMaster` turns the overlay's elements back into a
 * master for `applyComponentMasterEdit`: context copies are dropped, the master goes back to
 * where the snapshot had it, and copies that would clash with an existing slot become new
 * children.
 *
 * Placement: the largest non-text slot of the instance is matched to the same slot of the
 * master (by tag slot: snapshot ids are fresh each time). For an unscaled, unrotated instance
 * that is pixel exact. A scaled or rotated instance shows the master at its own size and angle,
 * centred on the instance.
 */
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { hashElementsVersion } from "@excalidraw/excalidraw";
import { newId, unionBounds, type El } from "../../agent/scene/draft";
import { isBoundText } from "../../extensions/components/geometry";
import { masterSnapshot } from "../../extensions/components/library";
import {
  groupOf,
  listComponents,
  tagFor,
  tagsOf,
  writeTags,
} from "../../extensions/components/model";

/** Marks the overlay's context copies; they're dropped on Done whatever the user did to them. */
export const CTX_KEY = "excalidrawDesktop.ctx";
/** Opacity factor of the context copies. */
export const CONTEXT_DIM = 0.25;

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
}

export interface MasterEditScene {
  componentId: string;
  name: string;
  /** Group id of the master in the overlay. */
  masterGroupId: string;
  masterIds: string[];
  /** Master + context copies, in the main scene's z-order. */
  elements: El[];
  files: BinaryFiles;
  /** How far the master was moved onto the instance (undone by `editedMaster`). */
  offset: { dx: number; dy: number };
  instanceCount: number;
  /** Version hash of the component's elements in the main scene when the overlay opened. */
  sourceKey: string;
  /** Version of each master element as seeded, to tell whether anything was edited. */
  seeded: Record<string, number>;
}

export const isContextCopy = (el: El) => Boolean(el.customData?.[CTX_KEY]);

/** The component `instanceGroupId` is an instance of, or null. */
export function componentOfInstanceGroup(
  elements: readonly El[],
  instanceGroupId: string,
): string | null {
  for (const el of elements) {
    if (el.isDeleted) continue;
    for (const t of tagsOf(el))
      if (t.role === "instance" && groupOf(el, t) === instanceGroupId) return t.componentId;
  }
  return null;
}

/** Version hash of every live element that belongs to component `cid`. */
export function componentKey(elements: readonly El[], cid: string): string {
  return String(hashElementsVersion(elements.filter((e) => !e.isDeleted && tagFor(e, cid))));
}

function viewRect(v: Viewport, margin: number) {
  const w = v.width / v.zoom;
  const h = v.height / v.zoom;
  const x = -v.scrollX;
  const y = -v.scrollY;
  return {
    minX: x - w * margin,
    minY: y - h * margin,
    maxX: x + w * (1 + margin),
    maxY: y + h * (1 + margin),
  };
}

/** Dimmed, locked, unbound, untagged copies of `els` with fresh ids, keyed by original id. */
function contextCopies(els: readonly El[]): Map<string, El> {
  const ids = new Map(els.map((e) => [e.id, newId()]));
  const remap = (id: string | null | undefined) => (id ? (ids.get(id) ?? null) : null);
  const out = new Map<string, El>();
  for (const e of els) {
    const r = e as unknown as Record<string, unknown>;
    const c: Record<string, unknown> = {
      ...e,
      id: ids.get(e.id)!,
      locked: true,
      opacity: Math.max(1, Math.round(e.opacity * CONTEXT_DIM)),
      customData: { [CTX_KEY]: 1 },
      frameId: remap(e.frameId),
      index: null,
      boundElements:
        e.boundElements
          ?.map((b) => ({ ...b, id: remap(b.id) }))
          .filter((b): b is { id: string; type: "arrow" | "text" } => !!b.id) ?? null,
      link: null,
    };
    if ("containerId" in r) c.containerId = remap(r.containerId as string | null);
    for (const end of ["startBinding", "endBinding"]) if (end in r) c[end] = null;
    out.set(e.id, c as unknown as El);
  }
  return out;
}

const area = (e: El) => Math.abs(e.width * e.height);
const close = (a: number, b: number) => Math.abs(a - b) < 0.5;

/** How far to move the master so it sits on the instance (see the module comment). */
function placement(inst: readonly El[], master: readonly El[], cid: string) {
  const anchor = inst.filter((e) => !isBoundText(e)).sort((a, b) => area(b) - area(a))[0];
  const twin = anchor && master.find((m) => tagFor(m, cid)?.slot === tagFor(anchor, cid)?.slot);
  if (
    anchor &&
    twin &&
    close(anchor.width, twin.width) &&
    close(anchor.height, twin.height) &&
    close(anchor.angle, twin.angle)
  )
    return { dx: anchor.x - twin.x, dy: anchor.y - twin.y };
  const a = unionBounds(inst);
  const b = unionBounds(master);
  if (!a || !b) return { dx: 0, dy: 0 };
  return {
    dx: (a.minX + a.maxX) / 2 - (b.minX + b.maxX) / 2,
    dy: (a.minY + a.maxY) / 2 - (b.minY + b.maxY) / 2,
  };
}

/** The overlay's scene for editing the master of `instanceGroupId`'s component in place. */
export function buildMasterEditScene(
  mainElements: readonly El[],
  mainFiles: BinaryFiles,
  instanceGroupId: string,
  viewport: Viewport,
): MasterEditScene {
  const cid = componentOfInstanceGroup(mainElements, instanceGroupId);
  if (!cid) throw new Error(`"${instanceGroupId}" is not a component instance`);
  const snap = masterSnapshot(mainElements, cid, instanceGroupId);
  const inst = mainElements.filter((e) => {
    if (e.isDeleted) return false;
    const t = tagFor(e, cid);
    return t?.role === "instance" && groupOf(e, t) === instanceGroupId;
  });
  const offset = placement(inst, snap.elements, cid);
  const placed = snap.elements.map(
    (m) => ({ ...m, x: m.x + offset.dx, y: m.y + offset.dy, index: null }) as El,
  );

  const instIds = new Set(inst.map((e) => e.id));
  const rect = viewRect(viewport, 1);
  const near = mainElements.filter((e) => {
    if (e.isDeleted || instIds.has(e.id)) return false;
    const b = unionBounds([e]);
    return (
      !!b &&
      b.maxX >= rect.minX &&
      b.minX <= rect.maxX &&
      b.maxY >= rect.minY &&
      b.minY <= rect.maxY
    );
  });
  const context = contextCopies(near);

  // Keep z-order: context in scene order, the master where the instance's first child was.
  const firstInst = mainElements.findIndex((e) => instIds.has(e.id));
  const elements: El[] = [];
  mainElements.forEach((e, i) => {
    if (i === firstInst) elements.push(...placed);
    const c = context.get(e.id);
    if (c) elements.push(c);
  });
  if (firstInst < 0) elements.push(...placed);

  const files: BinaryFiles = {};
  for (const e of elements) {
    const f = (e as { fileId?: string | null }).fileId;
    if (e.type === "image" && f && mainFiles[f]) files[f] = mainFiles[f];
  }

  const info = listComponents(mainElements).find((c) => c.componentId === cid);
  return {
    componentId: cid,
    name: info?.name ?? snap.name ?? "Component",
    masterGroupId: snap.masterGroupId,
    masterIds: placed.map((e) => e.id),
    elements,
    files,
    offset,
    instanceCount: info?.instances.length ?? 0,
    sourceKey: componentKey(mainElements, cid),
    seeded: Object.fromEntries(placed.map((e) => [e.id, e.version])),
  };
}

/** True when the overlay's master differs from what it was seeded with. */
export function masterChanged(scene: MasterEditScene, overlay: readonly El[]): boolean {
  const seen = new Set<string>();
  for (const e of overlay) {
    if (isContextCopy(e)) continue;
    const v = scene.seeded[e.id];
    if (v === undefined) {
      if (!e.isDeleted) return true;
      continue;
    }
    seen.add(e.id);
    if (e.isDeleted || e.version !== v) return true;
  }
  return seen.size !== scene.masterIds.length;
}

/**
 * The overlay's elements as the component's edited master: context copies (and bindings to them)
 * dropped, moved back to the snapshot's position. A copy of a master child (same slot) or of the
 * whole master (an instance of this component) loses its tag for this component, so it becomes a
 * new child rather than clashing with one.
 */
export function editedMaster(scene: MasterEditScene, overlay: readonly El[]): El[] {
  const cid = scene.componentId;
  const ctx = new Set(overlay.filter(isContextCopy).map((e) => e.id));
  const slots = new Set<string>();
  const out: El[] = [];
  for (const e of overlay) {
    if (e.isDeleted || ctx.has(e.id)) continue;
    const r: Record<string, unknown> = {
      ...e,
      x: e.x - scene.offset.dx,
      y: e.y - scene.offset.dy,
    };
    const own = tagFor(e, cid);
    if (own && (own.role !== "master" || slots.has(own.slot)))
      r.customData = writeTags(
        e,
        tagsOf(e).filter((t) => t.componentId !== cid),
      );
    else if (own) slots.add(own.slot);
    for (const end of ["startBinding", "endBinding"]) {
      const b = r[end] as { elementId: string } | null | undefined;
      if (b && ctx.has(b.elementId)) r[end] = null;
    }
    if (e.frameId && ctx.has(e.frameId)) r.frameId = null;
    if (e.boundElements) r.boundElements = e.boundElements.filter((b) => !ctx.has(b.id));
    out.push(r as unknown as El);
  }
  return out;
}

/** Image files the edited master uses, from the overlay. */
export function filesOf(els: readonly El[], files: BinaryFiles) {
  const ids = new Set(
    els.flatMap((e) => {
      const f = (e as { fileId?: string | null }).fileId;
      return e.type === "image" && f ? [f] : [];
    }),
  );
  return [...ids].flatMap((id) => (files[id] ? [files[id]] : []));
}
