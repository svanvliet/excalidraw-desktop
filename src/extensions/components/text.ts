/**
 * Text layout for instance children. Never copies the master's measured width: it re-measures
 * with the exported `convertToExcalidrawElements` (see reactor/textLayout.ts) because overrides,
 * scaling and fonts that loaded after the master was measured all change the result.
 * Results are memoised relative to the container, so N instances cost one measurement.
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { El, Patch } from "../reactor/reactor";
import { measureBoundText } from "../reactor/textLayout";

type TextEl = ExcalidrawTextElement;

const MAX_CACHE = 2000;
const boundCache = new Map<string, { dx: number; dy: number; patch: Patch; grow: number }>();
const freeCache = new Map<string, { width: number; height: number; text: string }>();

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/** Drop memoised measurements (fonts loaded, tests). */
export function clearTextCache(): void {
  boundCache.clear();
  freeCache.clear();
}

/**
 * Layout of `text` inside `container`: the text patch, and the container height needed (may be
 * larger than the container when the text doesn't fit). Null for containers Excalidraw can't
 * label through a skeleton (e.g. arrows).
 */
export function layoutBoundText(
  container: El,
  style: TextEl,
  text: string,
): { text: Patch; containerHeight: number } | null {
  const key = JSON.stringify([
    container.type,
    container.width,
    container.height,
    text,
    style.fontSize,
    style.fontFamily,
    style.textAlign,
    style.verticalAlign,
    style.lineHeight,
  ]);
  let hit = boundCache.get(key);
  if (!hit) {
    const probe = { ...container, x: 0, y: 0, angle: 0 } as El;
    const res = measureBoundText(probe, style, text);
    if (!res) return null;
    const { x, y, ...rest } = res.text;
    delete rest.angle;
    hit = remember(boundCache, key, {
      dx: x as number,
      dy: y as number,
      patch: rest,
      grow: res.containerHeight,
    });
  }
  return {
    text: {
      ...hit.patch,
      x: container.x + hit.dx,
      y: container.y + hit.dy,
      angle: container.angle,
    },
    containerHeight: hit.grow,
  };
}

/** Width/height and (unchanged) text of a free-standing text element. */
export function measureFreeText(
  style: TextEl,
  text: string,
): { width: number; height: number; text: string } {
  const key = JSON.stringify([
    text,
    style.fontSize,
    style.fontFamily,
    style.textAlign,
    style.lineHeight,
  ]);
  const hit = freeCache.get(key);
  if (hit) return hit;
  const [t] = convertToExcalidrawElements(
    [
      {
        type: "text",
        id: "__component_measure__",
        x: 0,
        y: 0,
        text,
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        textAlign: style.textAlign,
        verticalAlign: style.verticalAlign,
        lineHeight: style.lineHeight,
      },
    ] as never,
    { regenerateIds: false },
  ) as TextEl[];
  return remember(freeCache, key, { width: t.width, height: t.height, text: t.text });
}
