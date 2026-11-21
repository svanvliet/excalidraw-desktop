/**
 * Conversions between the canvas and the personal component library (FR-55, D-DX10):
 *
 *  - `masterToEntry`: a document's master → a `MyComponent` snapshot (top-left at 0,0).
 *  - `insertMyComponent`: a `MyComponent` → this document. If the document already has a master
 *    for that component id, places an instance of it; otherwise places the master at the point
 *    and an instance beside it. With `libraryBacked`, places only the instance (tagged
 *    `source: "library"`); the master stays in My components. Runs on a Draft, so the caller
 *    commits one undo step.
 *  - `libraryItemToEntry`: an Excalidraw library item → a new component (via the engine's
 *    `createComponent` on a scratch Draft, so the tags are the engine's own).
 *  - `entriesToExcalidrawLib`: `.excalidrawlib` JSON. The tags travel with the elements, so a
 *    library item added back to a canvas is a master again.
 *
 * Library entries are snapshots: saving again replaces the entry, and documents that already have
 * the master keep their own copy.
 */
import type { BinaryFileData, BinaryFiles, LibraryItem } from "@excalidraw/excalidraw/types";
import { Draft, newId, ToolError, type El } from "../../agent/scene/draft";
import { componentsOf, createComponent, insertInstance } from "../../extensions/components/actions";
import { componentMembers } from "../../extensions/components/sync";
import {
  COMPONENT_NS,
  listComponents,
  tagOf,
  withTag,
  type ComponentInfo,
} from "../../extensions/components/model";
import type { MyComponent } from "../../lib/componentLibraryStore";

const isPointy = (el: El): el is El & { points: readonly (readonly [number, number])[] } =>
  "points" in el && Array.isArray((el as { points?: unknown }).points);

/** Top-left of a set of elements (linear elements by their points). */
export function topLeft(els: readonly El[]): { x: number; y: number } {
  let x = Infinity;
  let y = Infinity;
  for (const el of els) {
    if (isPointy(el) && el.points.length) {
      for (const [px, py] of el.points) {
        x = Math.min(x, el.x + px);
        y = Math.min(y, el.y + py);
      }
    } else {
      x = Math.min(x, el.x);
      y = Math.min(y, el.y);
    }
  }
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

/** Writable view of an element while building a copy. */
type Mut = Record<string, unknown> & { x: number; y: number };

function fileIdOf(el: El): string | null {
  const f = (el as { fileId?: unknown }).fileId;
  return typeof f === "string" ? f : null;
}

/**
 * Copy `els` as a self-contained snapshot moved by (-dx, -dy): references to elements outside the
 * set (bindings, bound elements, frames) are dropped.
 */
function snapshot(els: readonly El[], dx: number, dy: number): El[] {
  const ids = new Set(els.map((e) => e.id));
  return els.map((el) => {
    const copy = structuredClone(el) as unknown as Mut;
    copy.x = el.x - dx;
    copy.y = el.y - dy;
    copy.frameId = null;
    copy.index = null;
    copy.locked = false;
    if (Array.isArray(copy.boundElements))
      copy.boundElements = (copy.boundElements as { id: string }[]).filter((b) => ids.has(b.id));
    if ("containerId" in copy && copy.containerId && !ids.has(copy.containerId as string))
      copy.containerId = null;
    for (const k of ["startBinding", "endBinding"] as const) {
      const b = copy[k] as { elementId?: string } | null | undefined;
      if (b && !ids.has(b.elementId ?? "")) copy[k] = null;
    }
    return copy as unknown as El;
  });
}

function filesFor(els: readonly El[], files: BinaryFiles | undefined) {
  const out: Record<string, BinaryFileData> = {};
  for (const el of els) {
    const id = fileIdOf(el);
    if (id && files?.[id]) out[id] = files[id];
  }
  return Object.keys(out).length ? out : undefined;
}

/** The live master of `componentId` in `elements`, or throws. */
function masterOf(
  elements: readonly El[],
  componentId: string,
): { info: ComponentInfo; els: El[] } {
  const info = listComponents(elements).find((c) => c.componentId === componentId);
  if (!info?.masterGroupId) throw new ToolError(`No component "${componentId}" on this canvas`);
  const ids = new Set(info.masterIds);
  return { info, els: elements.filter((e) => ids.has(e.id) && !e.isDeleted) };
}

/** Library-backed tag fields (the engine's contract; `withTag` doesn't know them in v1). */
export interface LibrarySource {
  source?: "library";
  libraryId?: string;
}

export function librarySourceOf(el: El | undefined): LibrarySource | null {
  const t = tagOf(el) as (LibrarySource & object) | null;
  return t?.source === "library" ? { source: "library", libraryId: t.libraryId } : null;
}

function withLibrarySource(el: El, libraryId: string): Record<string, unknown> {
  return {
    ...(el.customData ?? {}),
    [COMPONENT_NS]: { ...tagOf(el)!, source: "library", libraryId },
  };
}

/** Snapshot a document's master for the personal library. */
export function masterToEntry(
  elements: readonly El[],
  files: BinaryFiles | undefined,
  componentId: string,
  now = Date.now(),
): MyComponent {
  const { info, els } = masterOf(elements, componentId);
  const o = topLeft(els);
  const out: MyComponent = {
    id: componentId,
    name: info.name ?? "Component",
    elements: snapshot(els, o.x, o.y),
    created: now,
    updated: now,
  };
  const f = filesFor(els, files);
  if (f) out.files = f;
  return out;
}

export interface InsertedMyComponent {
  componentId: string;
  /** True when the master was placed too (it wasn't in this document yet). */
  placedMaster: boolean;
  /** Null when the instance is library-backed (no master in the document). */
  masterGroupId: string | null;
  instance: { groupId: string; ids: string[] };
  /** Image files the caller must add to the editor. */
  files: BinaryFileData[];
}

/**
 * Put a saved component into this document with its top-left at `at`. See the module comment
 * for the master-present / master-absent rule.
 */
export function insertMyComponent(
  draft: Draft,
  entry: MyComponent,
  at: { x: number; y: number },
  opts: { libraryBacked?: boolean } = {},
): InsertedMyComponent {
  const existing = componentsOf(draft).find((c) => c.componentId === entry.id && c.masterGroupId);
  if (existing) {
    const instance = insertInstance(draft, entry.id, at);
    return {
      componentId: entry.id,
      placedMaster: false,
      masterGroupId: existing.masterGroupId!,
      instance,
      files: [],
    };
  }
  const src = (entry.elements as readonly El[]).filter((e) => !e.isDeleted);
  if (
    !src.length ||
    src.some((e) => {
      const t = tagOf(e);
      return t?.role !== "master" || t.componentId !== entry.id;
    })
  )
    throw new ToolError(`Saved component "${entry.name}" is damaged and can't be inserted`);
  // Fresh element and group ids; slots and the component id stay, so instances keep linking.
  const ids = new Map(src.map((e) => [e.id, newId()]));
  const groups = new Map<string, string>();
  const group = (g: string) => {
    let n = groups.get(g);
    if (!n) groups.set(g, (n = newId()));
    return n;
  };
  const o = topLeft(src);
  for (const el of snapshot(src, o.x - at.x, o.y - at.y)) {
    const copy = el as unknown as Mut;
    copy.id = ids.get(el.id)!;
    copy.groupIds = el.groupIds.map(group);
    // The entry's name wins (it may have been renamed in My components).
    copy.customData = withTag(el, { ...tagOf(el)!, name: entry.name });
    if (Array.isArray(copy.boundElements))
      copy.boundElements = (copy.boundElements as { id: string; type: string }[]).map((b) => ({
        ...b,
        id: ids.get(b.id)!,
      }));
    if ("containerId" in copy && copy.containerId)
      copy.containerId = ids.get(copy.containerId as string) ?? null;
    for (const k of ["startBinding", "endBinding"] as const) {
      const b = copy[k] as { elementId: string } | null | undefined;
      if (b) copy[k] = { ...b, elementId: ids.get(b.elementId)! };
    }
    copy.version = 1;
    copy.versionNonce = Math.floor(Math.random() * 2 ** 31);
    copy.updated = Date.now();
    draft.add(copy as unknown as El);
  }
  const placed = componentsOf(draft).find((c) => c.componentId === entry.id && c.masterGroupId);
  if (!placed) throw new ToolError(`Saved component "${entry.name}" couldn't be placed`);
  if (opts.libraryBacked) {
    // Library-backed: the master stays in My components. Place the instance at the point, then
    // take the scratch master away again; the tag tells the engine not to promote the instance.
    const instance = insertInstance(draft, entry.id, at);
    for (const id of placed.masterIds) draft.update(id, { isDeleted: true });
    for (const id of instance.ids) {
      const el = draft.get(id)!;
      draft.update(id, { customData: withLibrarySource(el, entry.id) });
    }
    return {
      componentId: entry.id,
      placedMaster: false,
      masterGroupId: null,
      instance,
      files: Object.values(entry.files ?? {}),
    };
  }
  const instance = insertInstance(draft, entry.id);
  return {
    componentId: entry.id,
    placedMaster: true,
    masterGroupId: placed.masterGroupId!,
    instance,
    files: Object.values(entry.files ?? {}),
  };
}

/** Make an Excalidraw library item into a saved component. */
export function libraryItemToEntry(
  item: Pick<LibraryItem, "elements" | "name">,
  files?: BinaryFiles,
  now = Date.now(),
): MyComponent {
  const live = (item.elements as readonly El[]).filter((e) => !e.isDeleted);
  if (!live.length) throw new ToolError("That library item is empty");
  if (live.some((e) => e.type === "frame" || e.type === "magicframe"))
    throw new ToolError("Library items with frames can't become components");
  const name = item.name?.trim() || "Library item";
  // A component exported to .excalidrawlib and added back: keep it as it is.
  const first = tagOf(live[0]);
  if (
    first?.role === "master" &&
    live.every((e) => {
      const t = tagOf(e);
      return t?.role === "master" && t.componentId === first.componentId;
    })
  ) {
    const o = topLeft(live);
    const out: MyComponent = {
      id: first.componentId,
      name: first.name ?? name,
      elements: snapshot(live, o.x, o.y),
      created: now,
      updated: now,
    };
    const f = filesFor(live, files);
    if (f) out.files = f;
    return out;
  }
  const clean = snapshot(live, 0, 0).map((e) => ({ ...e, customData: withTag(e, null) }) as El);
  const draft = new Draft(clean);
  const roots = clean.filter((e) => !("containerId" in e && e.containerId)).map((e) => e.id);
  const res = createComponent(draft, roots, name);
  return masterToEntry(draft.toArray(), files, res.componentId, now);
}

export interface ExcalidrawLibExport {
  json: string;
  /** Image elements left out: `.excalidrawlib` has no place for image files. */
  droppedImages: number;
}

/**
 * `.excalidrawlib` (v2) JSON for saved components. The format carries no image files (and
 * Excalidraw 0.18 refuses images in its library), so image elements are left out and counted
 * for the caller to warn about; the images stay in "My components".
 */
export function entriesToExcalidrawLib(entries: readonly MyComponent[]): ExcalidrawLibExport {
  let droppedImages = 0;
  const libraryItems = entries.flatMap((e) => {
    const elements = e.elements.filter((el) => {
      if (el.type !== "image") return true;
      droppedImages++;
      return false;
    });
    if (!elements.length) return [];
    return [
      {
        id: e.id,
        status: "unpublished",
        created: e.created,
        name: e.name,
        // Self-contained again once the images are gone.
        elements: snapshot(elements, 0, 0),
      },
    ];
  });
  const json = JSON.stringify(
    { type: "excalidrawlib", version: 2, source: "excalidraw-desktop", libraryItems },
    null,
    2,
  );
  return { json, droppedImages };
}

/** Set a component's display name on its master and instance children (a Draft action). */
export function renameComponent(draft: Draft, componentId: string, name: string): void {
  const label = name.trim().slice(0, 80);
  if (!label) throw new ToolError("A component name can't be empty");
  for (const el of componentMembers(draft.toArray(), componentId)) {
    const tag = tagOf(el);
    if (!tag || el.isDeleted || tag.name === label) continue;
    draft.update(el.id, { customData: withTag(el, { ...tag, name: label }) });
  }
}
