/**
 * Reactor rule for line anchors (D-DX15, key = arrow id). A straight/curved arrow with a
 * customData pin is the source of its key; every snap target lists the arrows bound to it as
 * targets, so moving, resizing or rotating a shape re-snaps its pinned arrow ends in the same
 * flush (after styles and components, so a component instance's arrows follow too).
 *
 * Arrows the user is dragging right now are suspended (see `pointer.ts`): the rule would
 * otherwise pull a dragged end back to its pin; the pointer-up handler settles them instead.
 */
import { isElbowArrow } from "../../lib/elbowAnchors";
import { hasPin, isArrow, isSnapTarget, pinnedPatch } from "../../lib/lineAnchors";
import type { El, ReactorLink, ReactorRule } from "../reactor/reactor";

export interface AnchorRule extends ReactorRule {
  /** Ids the rule leaves alone until `resume` (arrows mid-drag). */
  suspend(ids: Iterable<string>): void;
  resume(): void;
}

export function createAnchorRule(): AnchorRule {
  const suspended = new Set<string>();
  return {
    name: "anchors",
    links(el: El): readonly ReactorLink[] {
      if (isArrow(el)) return hasPin(el) ? [{ role: "source", key: el.id }] : [];
      if (!isSnapTarget(el) || !el.boundElements) return [];
      const out: ReactorLink[] = [];
      for (const b of el.boundElements)
        if (b.type === "arrow") out.push({ role: "target", key: b.id });
      return out;
    },
    reconcile(key, _change, ctx) {
      if (suspended.has(key)) return;
      const arrow = ctx.get(key);
      if (!isArrow(arrow) || arrow.isDeleted || isElbowArrow(arrow) || !hasPin(arrow)) return;
      const patch = pinnedPatch(arrow, ctx.get);
      if (patch) ctx.patch(key, { ...patch });
    },
    suspend(ids) {
      for (const id of ids) suspended.add(id);
    },
    resume() {
      suspended.clear();
    },
  };
}
