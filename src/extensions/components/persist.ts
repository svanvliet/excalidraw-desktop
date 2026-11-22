import type { El } from "../reactor/reactor";
import { groupOf, tagsOf } from "./model";

/**
 * The elements a saved file keeps: the live ones, plus component instance children that are
 * hidden (soft-deleted, still tagged) inside an instance that's still on the canvas (FR-69).
 * Masters live off-canvas and are rebuilt from instances, so a slot every instance hides (e.g.
 * the unchosen branch of a choice) would otherwise be lost on reload. Slots removed from a
 * component are untagged, so they aren't kept.
 */
export function persistedElements<T extends El>(elements: readonly T[]): T[] {
  const key = (el: El) =>
    tagsOf(el).flatMap((t) => {
      const g = t.role === "instance" ? groupOf(el, t) : null;
      return g ? [`${t.componentId}\u0000${g}`] : [];
    });
  const live = new Set(elements.filter((e) => !e.isDeleted).flatMap(key));
  return elements.filter((el) => !el.isDeleted || key(el).some((k) => live.has(k)));
}
