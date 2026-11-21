/**
 * Reactor rule for smart containers (docs/containers.md). Key = group id: every element links as
 * a target to each of its groups and a container box as the source of its own group, so any
 * change inside a container (move, resize, text edit, add, delete, undo) re-flows it. Groups
 * without an active box re-flow nothing.
 *
 * While the user drags, resizes or rotates, or draws a new element, those elements are *held*:
 * siblings re-flow around them live, and `createHoldTracker` settles them when the gesture ends.
 */
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { El, Reactor, ReactorLink, ReactorRule } from "../../extensions/reactor/reactor";
import { containerGroupOf, hasLayoutTag } from "./model";
import { reflow } from "./stack";

const NONE: readonly ReactorLink[] = [];

export function createContainerRule(
  opts: { held?: () => ReadonlySet<string> | null } = {},
): ReactorRule {
  return {
    name: "containers",
    links(el: El) {
      if (!el.groupIds.length) return NONE;
      const own = hasLayoutTag(el) ? containerGroupOf(el) : null;
      return el.groupIds.map((key) => ({ role: key === own ? "source" : "target", key }));
    },
    reconcile(key, _change, ctx) {
      const held = opts.held?.();
      reflow(
        {
          get: ctx.get,
          members: ctx.members,
          patch: ctx.patch,
          ...(held?.size ? { held: (id: string) => held.has(id) } : {}),
        },
        key,
      );
    },
  };
}

type GestureState = Pick<
  AppState,
  | "selectedElementIds"
  | "selectedElementsAreBeingDragged"
  | "isResizing"
  | "isRotating"
  | "newElement"
  | "resizingElement"
>;

/** Elements a gesture in progress owns, or null when none is. */
export function heldBy(s: GestureState): Set<string> | null {
  const out = new Set<string>();
  if (s.selectedElementsAreBeingDragged || s.isResizing || s.isRotating) {
    for (const [id, on] of Object.entries(s.selectedElementIds)) if (on) out.add(id);
  }
  if (s.resizingElement) out.add(s.resizingElement.id);
  if (s.newElement) out.add(s.newElement.id);
  return out.size ? out : null;
}

/**
 * Tracks the gesture-held set from `api.onChange`. When a gesture ends, the elements it held are
 * invalidated on the reactor so their containers settle (snap the held unit into its slot).
 */
export function createHoldTracker() {
  let held: Set<string> | null = null;
  let off: (() => void) | null = null;
  return {
    held: () => held,
    attach(api: Pick<ExcalidrawImperativeAPI, "onChange">, reactor: Pick<Reactor, "invalidate">) {
      off = api.onChange((_els, appState) => {
        const next = heldBy(appState);
        if (held && !next) reactor.invalidate(held);
        else if (held && next) for (const id of held) if (!next.has(id)) reactor.invalidate([id]);
        held = next;
      });
    },
    dispose() {
      off?.();
      off = null;
      held = null;
    },
  };
}
