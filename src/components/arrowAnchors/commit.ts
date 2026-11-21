/** Scene writes for the Anchors section, each one undo step. */
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import {
  anchorBindings,
  isElbowArrow,
  routedElbow,
  type Anchor,
  type AnchorChange,
} from "../../lib/elbowAnchors";
import { ENDS, isArrow, snapPatches } from "../../lib/lineAnchors";
import type { PanelApi } from "../propertiesPanel/panel";

type Api = Pick<PanelApi, "getSceneElementsIncludingDeleted" | "updateScene">;

/** Re-bind and re-route an elbow arrow. */
export function setElbowAnchors(api: Api, arrowId: string, change: AnchorChange): void {
  const all = api.getSceneElementsIncludingDeleted();
  const byId = new Map(all.map((e) => [e.id, e]));
  const arrow = byId.get(arrowId);
  if (!arrow || arrow.isDeleted || !isElbowArrow(arrow)) {
    throw new Error("Select an elbow arrow");
  }
  const bindings = anchorBindings(arrow, change, (id) => {
    const el = byId.get(id);
    return el && !el.isDeleted ? el : undefined;
  });
  const next = routedElbow(arrow, bindings);
  api.updateScene({
    elements: all.map((e) => (e.id === arrowId ? next : e)),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

/** An end's anchor for {@link setLineAnchors}: a face midpoint / centre pin, or "free". */
export type LineAnchor = Anchor | "free";

/**
 * Pin a straight or curved arrow's bound ends to a face midpoint or the centre of their shapes
 * (D-DX15), or free them back to Excalidraw's sliding binding.
 */
export function setLineAnchors(
  api: Api,
  arrowId: string,
  change: Partial<Record<"start" | "end", LineAnchor>>,
): void {
  let all = api.getSceneElementsIncludingDeleted();
  const found = all.find((e) => e.id === arrowId);
  if (!found || found.isDeleted || !isArrow(found) || isElbowArrow(found)) {
    throw new Error("Select a straight or curved arrow");
  }
  if (!found.customData) {
    // History can't undo customData going from undefined to set, so give it a baseline.
    all = all.map((e) => (e.id === arrowId ? ({ ...e, customData: {} } as typeof e) : e));
    api.updateScene({ elements: all, captureUpdate: CaptureUpdateAction.NEVER });
  }
  const byId = new Map(all.map((e) => [e.id, e]));
  const get = (id: string) => {
    const el = byId.get(id);
    return el && !el.isDeleted ? el : undefined;
  };
  for (const end of ENDS) {
    const anchor = change[end];
    if (!anchor) continue;
    const arrow = byId.get(arrowId) as typeof found;
    const bound = (end === "start" ? arrow.startBinding : arrow.endBinding)?.elementId;
    const shape = bound ? get(bound) : undefined;
    if (anchor !== "free" && !shape) throw new Error(`The ${end} of this arrow isn't bound`);
    const patches = snapPatches(
      arrow,
      end,
      anchor === "free" ? null : { shape: shape!, anchor },
      get,
    );
    for (const [id, patch] of patches) byId.set(id, newElementWith(byId.get(id)!, patch as never));
  }
  api.updateScene({
    elements: all.map((e) => byId.get(e.id) ?? e),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}
