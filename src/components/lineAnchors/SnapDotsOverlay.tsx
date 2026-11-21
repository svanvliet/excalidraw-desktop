/**
 * Snap dots for line anchors (D-DX15): while an arrow end is being dragged (see
 * `extensions/anchors/pointer.ts`), mark the face midpoints and centre of the shapes near the
 * pointer and highlight the one a drop would snap to. Purely visual (pointer-events: none).
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useState } from "react";
import { bypassKey, subscribeSnapDrag, type SnapDrag } from "../../extensions/anchors/pointer";
import { dotsNear, type Dot } from "./dots";

export function SnapDotsOverlay({
  api,
  enabled,
}: {
  api: ExcalidrawImperativeAPI;
  enabled: boolean;
}) {
  const [drag, setDrag] = useState<SnapDrag | null>(null);
  const [dots, setDots] = useState<Dot[]>([]);

  useEffect(() => subscribeSnapDrag(setDrag), []);

  useEffect(() => {
    if (!drag || !enabled) {
      setDots([]);
      return;
    }
    let last: PointerEvent | null = null;
    const update = (e: { clientX: number; clientY: number; metaKey: boolean; ctrlKey: boolean }) =>
      setDots(bypassKey(e) ? [] : dotsNear(api, drag, { x: e.clientX, y: e.clientY }));
    const onMove = (e: PointerEvent) => {
      last = e;
      update(e);
    };
    const onKey = (e: KeyboardEvent) => {
      if (last)
        update({
          clientX: last.clientX,
          clientY: last.clientY,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
        });
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [api, drag, enabled]);

  if (!dots.length) return null;
  return (
    <div className="snap-dots" aria-hidden="true" data-testid="snap-dots">
      {dots.map((d) => (
        <span
          key={d.key}
          className={`snap-dots__dot${d.active ? " snap-dots__dot--active" : ""}`}
          style={{ left: d.x, top: d.y }}
        />
      ))}
    </div>
  );
}
