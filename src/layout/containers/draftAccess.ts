import type { ExcalidrawArrowElement } from "@excalidraw/excalidraw/element/types";
import type { Draft } from "../../agent/scene/draft";
import { followBoundArrows } from "../../extensions/reactor/arrows";
import type { El } from "../../extensions/reactor/reactor";
import { reflowAround, type LayoutAccess } from "./stack";

export function draftLayoutAccess(draft: Draft): LayoutAccess {
  return {
    get: (id) => draft.peek(id),
    members: (g) => draft.toArray().filter((e) => e.groupIds.includes(g)),
    patch: (id, p) => {
      draft.update(id, p);
    },
  };
}

/**
 * Re-flow (inside the draft, so it lands in the same undo step) every container holding any of
 * `ids`, and keep arrows bound to what moved attached — as the live reactor does.
 */
export function reflowDraft(draft: Draft, ids: Iterable<string>): Set<string> {
  const before = new Map<string, El>(draft.toArray().map((e) => [e.id, e]));
  const moved = reflowAround(draftLayoutAccess(draft), ids);
  if (moved.size) {
    const patched = new Map<string, El>([...moved].map((id) => [id, draft.peek(id)!]));
    for (const a of followBoundArrows(patched, before) as ExcalidrawArrowElement[]) {
      draft.update(a.id, {
        x: a.x,
        y: a.y,
        points: a.points,
        width: a.width,
        height: a.height,
      });
    }
  }
  return moved;
}
