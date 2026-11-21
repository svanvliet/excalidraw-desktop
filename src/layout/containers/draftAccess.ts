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

export function snapshot(draft: Draft): Map<string, El> {
  return new Map(draft.toArray().map((e) => [e.id, e]));
}

/** Move arrows bound to anything whose box changed since `before` (as the live reactor does). */
export function followDraftArrows(draft: Draft, before: ReadonlyMap<string, El>): void {
  const patched = new Map<string, El>();
  for (const id of draft.changed) {
    const next = draft.peek(id);
    const prev = before.get(id);
    if (!next || !prev || next.type === "arrow") continue;
    if (
      next.x !== prev.x ||
      next.y !== prev.y ||
      next.width !== prev.width ||
      next.height !== prev.height
    ) {
      patched.set(id, next);
    }
  }
  if (!patched.size) return;
  for (const a of followBoundArrows(patched, before) as ExcalidrawArrowElement[]) {
    draft.update(a.id, { x: a.x, y: a.y, points: a.points, width: a.width, height: a.height });
  }
}

/**
 * Re-flow (inside the draft, so it lands in the same undo step) every container holding any of
 * `ids`, and keep arrows bound to what moved attached. `before` defaults to "now"; pass an
 * earlier snapshot to also carry arrows along with moves made since then.
 */
export function reflowDraft(
  draft: Draft,
  ids: Iterable<string>,
  before: ReadonlyMap<string, El> = snapshot(draft),
): Set<string> {
  const moved = reflowAround(draftLayoutAccess(draft), ids);
  followDraftArrows(draft, before);
  return moved;
}
