/**
 * EXPERIMENTAL (reactor spike). `onDuplicate` handler: copies of a mirror *source* (Ctrl/Cmd+D,
 * paste, library insert, Alt-drag) become *targets* of that source, offset by where the copy
 * landed. Runs inside Excalidraw's own duplicate/paste action, so it is part of the same single
 * undo step. A pasted source whose original isn't in the scene stays a source (orphan paste).
 *
 * Alt-drag caveat: Excalidraw gives the *stationary* copy the new ids and keeps dragging the
 * original, so the stationary copy becomes the instance (offset 0) and follows the drag. A real
 * Components v1 must special-case this (see docs/reactor-spike.md).
 */
import type { El } from "./reactor";
import { mirrorLinkOf, withMirrorLink } from "./mirrorRule";

export function mirrorOnDuplicate(next: readonly El[], prev: readonly El[]): El[] | void {
  const prevIds = new Set<string>();
  const sources = new Map<string, El>();
  for (const el of prev) {
    prevIds.add(el.id);
    const l = mirrorLinkOf(el);
    if (l?.role === "source" && !el.isDeleted) sources.set(l.key, el);
  }
  let changed = false;
  const out = next.map((el) => {
    if (prevIds.has(el.id)) return el;
    const l = mirrorLinkOf(el);
    const src = l && sources.get(l.key);
    if (!l || !src) return el;
    changed = true;
    return withMirrorLink(el, {
      role: "target",
      key: l.key,
      dx: el.x - src.x,
      dy: el.y - src.y,
      ...(l.role === "target" && l.overrides ? { overrides: l.overrides } : {}),
    });
  });
  return changed ? out : undefined;
}
