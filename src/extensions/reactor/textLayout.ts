/**
 * EXPERIMENTAL (reactor spike). Re-measures overridden bound text without Excalidraw's
 * unexported `redrawTextBoundingBox`/`wrapText`: build a one-off labelled-container skeleton with
 * the exported `convertToExcalidrawElements` (which wraps + centres via the same internal code)
 * and copy the resulting text geometry onto the existing text id.
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { El, Patch } from "./reactor";

type LabelContainerType = "rectangle" | "ellipse" | "diamond";

/** Layout of `text` inside `container`; returns text and (possibly grown) container height. */
export function measureBoundText(
  container: El,
  textEl: ExcalidrawTextElement,
  text: string,
): { text: Patch; containerHeight: number } | null {
  if (!["rectangle", "ellipse", "diamond"].includes(container.type)) return null;
  const out = convertToExcalidrawElements(
    [
      {
        type: container.type as LabelContainerType,
        id: "__reactor_measure__",
        x: container.x,
        y: container.y,
        width: container.width,
        height: container.height,
        angle: container.angle,
        label: {
          text,
          fontSize: textEl.fontSize,
          fontFamily: textEl.fontFamily,
          textAlign: textEl.textAlign,
          verticalAlign: textEl.verticalAlign,
          strokeColor: textEl.strokeColor,
          lineHeight: textEl.lineHeight,
        },
      },
    ] as never,
    { regenerateIds: false },
  );
  const box = out.find((e) => e.id === "__reactor_measure__");
  const t = out.find((e) => e.type === "text") as ExcalidrawTextElement | undefined;
  if (!box || !t) return null;
  return {
    text: {
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      text: t.text,
      originalText: t.originalText,
      angle: container.angle,
    },
    containerHeight: box.height,
  };
}
