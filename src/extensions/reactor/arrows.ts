/**
 * EXPERIMENTAL (reactor spike). Moving a target with `updateScene` doesn't re-route the arrows
 * bound to it — Excalidraw only does that inside its own interaction handlers, and
 * `updateBoundElements` isn't exported. Bindings (ids) survive regardless; this keeps the bound
 * ends attached by mapping each end through the target's old → new box.
 *
 * Limits: unrotated boxes only; elbow arrows are only translated (when every bound end moved by
 * the same delta), never re-routed.
 */
import { newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawArrowElement } from "@excalidraw/excalidraw/element/types";
import type { El } from "./reactor";

type Pt = readonly [number, number];
type Box = { x: number; y: number; width: number; height: number };

const boxMoved = (a: Box, b: Box) =>
  a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;

/** Inside the box: proportional. Outside (the binding gap): same distance from the nearest edge. */
function mapAxis(p: number, a0: number, aLen: number, b0: number, bLen: number): number {
  if (p < a0) return b0 - (a0 - p);
  if (p > a0 + aLen) return b0 + bLen + (p - a0 - aLen);
  return aLen ? b0 + ((p - a0) / aLen) * bLen : b0 + bLen / 2;
}

function mapPoint(p: Pt, from: Box, to: Box): [number, number] {
  return [
    mapAxis(p[0], from.x, from.width, to.x, to.width),
    mapAxis(p[1], from.y, from.height, to.y, to.height),
  ];
}

function rebuild(abs: Array<[number, number]>): Partial<ExcalidrawArrowElement> {
  const [ox, oy] = abs[0];
  const points = abs.map(([x, y]) => [x - ox, y - oy] as [number, number]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: ox,
    y: oy,
    points: points as never,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** Arrows (new versions) that need moving because a bound element in `patched` moved. */
export function followBoundArrows(
  patched: ReadonlyMap<string, El>,
  before: ReadonlyMap<string, El>,
): El[] {
  const out = new Map<string, El>();
  for (const [id, next] of patched) {
    const prev = before.get(id);
    if (!prev || !boxMoved(prev, next)) continue;
    for (const b of next.boundElements ?? []) {
      if (b.type !== "arrow" || patched.has(b.id)) continue;
      const arrow = (out.get(b.id) ?? before.get(b.id)) as ExcalidrawArrowElement | undefined;
      if (!arrow || arrow.isDeleted || arrow.type !== "arrow") continue;
      const abs = arrow.points.map(([px, py]) => [arrow.x + px, arrow.y + py] as [number, number]);
      const ends: Array<0 | 1> = [];
      if (arrow.startBinding?.elementId === id) ends.push(0);
      if (arrow.endBinding?.elementId === id) ends.push(1);
      if (ends.length === 0) continue;
      if (arrow.elbowed) {
        // Translate only (once); re-routing needs Excalidraw internals.
        if (out.has(arrow.id)) continue;
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const other = arrow.startBinding?.elementId === id ? arrow.endBinding : arrow.startBinding;
        const otherMoved = other && other.elementId !== id && patched.get(other.elementId);
        const sameDelta =
          !other ||
          other.elementId === id ||
          (otherMoved &&
            otherMoved.x - before.get(other.elementId)!.x === dx &&
            otherMoved.y - before.get(other.elementId)!.y === dy);
        if (!sameDelta || next.width !== prev.width || next.height !== prev.height) continue;
        out.set(arrow.id, newElementWith(arrow, { x: arrow.x + dx, y: arrow.y + dy }));
        continue;
      }
      for (const end of ends) {
        const i = end === 0 ? 0 : abs.length - 1;
        abs[i] = mapPoint(abs[i], prev, next);
      }
      out.set(arrow.id, newElementWith(arrow, rebuild(abs) as never));
    }
  }
  return [...out.values()];
}
