/**
 * `onDuplicate` for Components v1. Runs inside Excalidraw's duplicate / paste / Alt-drag action,
 * so whatever it returns is part of that single undo step.
 *
 *  - A copy of a whole master (new group) becomes a new instance of it.
 *  - Alt-drag: Excalidraw leaves the new ids behind and keeps dragging the originals. When every
 *    master copy sits exactly where its original is, or ahead of it in z-order (Alt-drag puts the
 *    copies in the originals' slots and appends the originals), the roles swap: the stationary
 *    copies stay the master and the dragged originals become the instance.
 *  - A copy of an instance (new group) is another instance with the same overrides.
 *  - A copy made inside a master group (group editing) becomes a new master child; inside an
 *    instance group it is detached (instances only hold children mirrored from the master).
 *  - A pasted master whose component has no live master here stays a master.
 *
 * Each component tag of an element is handled on its own, so copies of nested instances follow
 * the same rules per component (a copied master of B holding an A instance becomes a B instance
 * holding a new A instance, owned by it).
 */
import type { El } from "../reactor/reactor";
import { baseOf, boxOf, originOf } from "./geometry";
import { groupOf, tagFor, tagsOf, withoutTag, withTag, type ComponentTag } from "./model";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export function componentsOnDuplicate(next: readonly El[], prev: readonly El[]): El[] | void {
  const prevIds = new Set<string>();
  /** componentId → master group → live children */
  const masters = new Map<string, Map<string, El[]>>();
  const prevGroups = new Set<string>();
  const prevById = new Map<string, El>();
  for (const el of prev) {
    prevIds.add(el.id);
    prevById.set(el.id, el);
    if (el.isDeleted) continue;
    for (const tag of tagsOf(el)) {
      const g = groupOf(el, tag);
      if (!g) continue;
      prevGroups.add(g);
      if (tag.role !== "master") continue;
      let byGroup = masters.get(tag.componentId);
      if (!byGroup) masters.set(tag.componentId, (byGroup = new Map()));
      const list = byGroup.get(g);
      if (list) list.push(el);
      else byGroup.set(g, [el]);
    }
  }

  const replace = new Map<string, El>();
  const nextById = new Map(next.map((e) => [e.id, e]));
  const indexOf = new Map(next.map((e, i) => [e.id, i]));
  const cur = (id: string): El => replace.get(id) ?? nextById.get(id) ?? prevById.get(id)!;
  const set = (el: El, customData: Record<string, unknown>) =>
    replace.set(el.id, { ...el, customData } as El);

  /** New tagged elements per (componentId, new group). */
  const copies = new Map<string, { cid: string; ids: string[] }>();
  for (const el0 of next) {
    if (prevIds.has(el0.id)) continue;
    for (const tag of tagsOf(el0)) {
      const el = cur(el0.id);
      const g = groupOf(el, tag);
      if (!g) {
        set(el, withoutTag(el, tag.componentId));
        continue;
      }
      if (prevGroups.has(g)) {
        // Copied inside an existing component group.
        if (tag.role === "master") set(el, withTag(el, { ...tag, slot: el.id }));
        else set(el, withoutTag(el, tag.componentId));
        continue;
      }
      const k = `${tag.componentId}\u0000${g}`;
      const entry = copies.get(k);
      if (entry) entry.ids.push(el.id);
      else copies.set(k, { cid: tag.componentId, ids: [el.id] });
    }
  }

  for (const { cid, ids } of copies.values()) {
    const els = ids.map(cur).filter((e) => tagFor(e, cid));
    const T = (e: El) => tagFor(e, cid)!;
    if (!els.some((e) => T(e).role === "master")) continue; // instance copies stay as-is
    const byGroup = masters.get(cid);
    if (!byGroup?.size) continue; // orphan paste: stays a master
    // The master these were copied from: the live group sharing the most slots.
    const slots = new Set(els.map((e) => T(e).slot));
    let srcGroup = "";
    let best = -1;
    for (const [g, list] of byGroup) {
      const n = list.filter((m) => slots.has(T(m).slot)).length;
      if (n > best || (n === best && g < srcGroup)) [srcGroup, best] = [g, n];
    }
    const src = byGroup.get(srcGroup)!;
    const srcBySlot = new Map(src.map((m) => [T(m).slot, m]));
    const origin = originOf(src);

    const altDrag = els.every((e) => {
      const m = srcBySlot.get(T(e).slot);
      if (!m) return false;
      const a = boxOf(e);
      const b = boxOf(m);
      if (!near(a.w, b.w) || !near(a.h, b.h)) return false;
      // Excalidraw has already moved the originals by the first drag step, but it puts each copy
      // in its original's z-slot and appends the originals; duplicate and paste go after them.
      return (near(a.cx, b.cx) && near(a.cy, b.cy)) || indexOf.get(e.id)! < indexOf.get(m.id)!;
    });
    if (altDrag) {
      // Copies stay the master; the dragged originals become the instance.
      for (const m0 of src) {
        const m = cur(m0.id);
        const tag: ComponentTag = {
          ...T(m),
          role: "instance",
          promoted: undefined,
          base: baseOf(m, origin),
        };
        set(m, withTag(m, tag));
      }
      for (const e of els) {
        const t = T(e);
        if (t.promoted) set(e, withTag(e, { ...t, promoted: undefined }));
      }
      continue;
    }
    for (const e of els) {
      const t = T(e);
      const m = srcBySlot.get(t.slot);
      const tag: ComponentTag = {
        ...t,
        role: "instance",
        promoted: undefined,
        base: baseOf(m ?? e, m ? origin : originOf(els)),
      };
      set(e, withTag(e, tag));
    }
  }

  if (!replace.size) return;
  return next.map((el) => replace.get(el.id) ?? el);
}
