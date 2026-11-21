/**
 * `onDuplicate` for Components v1. Runs inside Excalidraw's duplicate / paste / Alt-drag action,
 * so whatever it returns is part of that single undo step.
 *
 *  - A copy of a whole master (new group) becomes a new instance of it.
 *  - Alt-drag: Excalidraw leaves the new ids behind and keeps dragging the originals. When every
 *    master copy sits exactly where its original is, the roles swap: the stationary copies stay
 *    the master and the dragged originals become the instance.
 *  - A copy of an instance (new group) is another instance with the same overrides.
 *  - A copy made inside a master group (group editing) becomes a new master child; inside an
 *    instance group it is detached (instances only hold children mirrored from the master).
 *  - A pasted master whose component has no live master here stays a master.
 */
import type { El } from "../reactor/reactor";
import { baseOf, boxOf, originOf } from "./geometry";
import { groupOf, tagOf, withTag, type ComponentTag } from "./model";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export function componentsOnDuplicate(next: readonly El[], prev: readonly El[]): El[] | void {
  const prevIds = new Set<string>();
  /** componentId → master group → live children */
  const masters = new Map<string, Map<string, El[]>>();
  const prevGroups = new Set<string>();
  for (const el of prev) {
    prevIds.add(el.id);
    const tag = tagOf(el);
    const g = tag && groupOf(el, tag);
    if (!tag || !g || el.isDeleted) continue;
    prevGroups.add(g);
    if (tag.role !== "master") continue;
    let byGroup = masters.get(tag.componentId);
    if (!byGroup) masters.set(tag.componentId, (byGroup = new Map()));
    const list = byGroup.get(g);
    if (list) list.push(el);
    else byGroup.set(g, [el]);
  }

  /** New tagged elements per (componentId, new group). */
  const copies = new Map<string, El[]>();
  const replace = new Map<string, El>();
  for (const el of next) {
    if (prevIds.has(el.id)) continue;
    const tag = tagOf(el);
    if (!tag) continue;
    const g = groupOf(el, tag);
    if (!g) {
      replace.set(el.id, { ...el, customData: withTag(el, null) } as El);
      continue;
    }
    if (prevGroups.has(g)) {
      // Copied inside an existing component group.
      const keep = tag.role === "master" ? { ...tag, slot: el.id } : null;
      replace.set(el.id, { ...el, customData: withTag(el, keep) } as El);
      continue;
    }
    const k = `${tag.componentId}\u0000${g}`;
    const list = copies.get(k);
    if (list) list.push(el);
    else copies.set(k, [el]);
  }

  for (const els of copies.values()) {
    const tag0 = tagOf(els[0])!;
    if (!els.some((e) => tagOf(e)!.role === "master")) continue; // instance copies stay as-is
    const byGroup = masters.get(tag0.componentId);
    if (!byGroup?.size) continue; // orphan paste: stays a master
    // The master these were copied from: the live group sharing the most slots.
    const slots = new Set(els.map((e) => tagOf(e)!.slot));
    let srcGroup = "";
    let best = -1;
    for (const [g, list] of byGroup) {
      const n = list.filter((m) => slots.has(tagOf(m)!.slot)).length;
      if (n > best || (n === best && g < srcGroup)) [srcGroup, best] = [g, n];
    }
    const src = byGroup.get(srcGroup)!;
    const srcBySlot = new Map(src.map((m) => [tagOf(m)!.slot, m]));
    const origin = originOf(src);

    const altDrag = els.every((e) => {
      const m = srcBySlot.get(tagOf(e)!.slot);
      if (!m) return false;
      const a = boxOf(e);
      const b = boxOf(m);
      return near(a.cx, b.cx) && near(a.cy, b.cy) && near(a.w, b.w) && near(a.h, b.h);
    });
    if (altDrag) {
      // Copies stay the master; the dragged originals become the instance.
      for (const m of src) {
        const t = tagOf(m)!;
        const tag: ComponentTag = {
          ...t,
          role: "instance",
          promoted: undefined,
          base: baseOf(m, origin),
        };
        replace.set(m.id, { ...m, customData: withTag(m, tag) } as El);
      }
      for (const e of els) {
        const t = tagOf(e)!;
        if (t.promoted)
          replace.set(e.id, { ...e, customData: withTag(e, { ...t, promoted: undefined }) } as El);
      }
      continue;
    }
    for (const e of els) {
      const t = tagOf(e)!;
      const m = srcBySlot.get(t.slot);
      const tag: ComponentTag = {
        ...t,
        role: "instance",
        promoted: undefined,
        base: baseOf(m ?? e, m ? origin : originOf(els)),
      };
      replace.set(e.id, { ...e, customData: withTag(e, tag) } as El);
    }
  }

  if (!replace.size) return;
  return next.map((el) => replace.get(el.id) ?? el);
}
