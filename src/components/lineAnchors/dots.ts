/** Snap-dot positions (viewport coordinates) for the overlay; see SnapDotsOverlay. */
import { sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { SnapDrag } from "../../extensions/anchors/pointer";
import { isSnapTarget, nearestDot, snapDots, SNAP_TOLERANCE_PX } from "../../lib/lineAnchors";

/** Shapes within this many screen pixels of the pointer show their dots. */
const NEAR_PX = 48;

export interface Dot {
  key: string;
  x: number;
  y: number;
  active: boolean;
}

export function dotsNear(
  api: Pick<ExcalidrawImperativeAPI, "getSceneElements" | "getAppState">,
  drag: SnapDrag,
  client: { x: number; y: number },
): Dot[] {
  const state = api.getAppState();
  const zoom = state.zoom.value;
  const { x, y } = viewportCoordsToSceneCoords({ clientX: client.x, clientY: client.y }, state);
  const near = NEAR_PX / zoom;
  const shapes = api.getSceneElements().filter((el) => {
    if (el.id === drag.arrowId || !isSnapTarget(el)) return false;
    const r = Math.hypot(el.width, el.height) / 2 + near;
    return Math.hypot(el.x + el.width / 2 - x, el.y + el.height / 2 - y) <= r;
  });
  const hit = nearestDot(shapes, [x, y], SNAP_TOLERANCE_PX / zoom);
  return shapes.flatMap((shape) =>
    snapDots(shape).map(({ anchor, point }) => {
      const v = sceneCoordsToViewportCoords({ sceneX: point[0], sceneY: point[1] }, state);
      return {
        key: `${shape.id}:${anchor}`,
        x: v.x,
        y: v.y,
        active: hit?.shape.id === shape.id && hit.anchor === anchor,
      };
    }),
  );
}
