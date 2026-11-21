/** Scene write for the Anchors section: re-bind and re-route an elbow arrow as one undo step. */
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import {
  anchorBindings,
  isElbowArrow,
  routedElbow,
  type AnchorChange,
} from "../../lib/elbowAnchors";
import type { PanelApi } from "../propertiesPanel/panel";

export function setElbowAnchors(
  api: Pick<PanelApi, "getSceneElementsIncludingDeleted" | "updateScene">,
  arrowId: string,
  change: AnchorChange,
): void {
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
