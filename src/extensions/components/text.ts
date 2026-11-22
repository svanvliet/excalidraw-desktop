/**
 * Text layout for instance children. Never copies the master's measured width: it re-measures
 * with the exported `convertToExcalidrawElements` (see reactor/textLayout.ts) because overrides,
 * scaling and fonts that loaded after the master was measured all change the result.
 * Results are memoised relative to the container, so N instances cost one measurement.
 *
 * A measurement taken before the element's web font has loaded uses the browser's fallback face
 * (Excalifont text measures ~20% narrower), so it is never memoised and `fontReady` reports it;
 * the host re-measures component text once fonts load (`watchComponentFonts` in host.ts).
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { El, Patch } from "../reactor/reactor";
import { measureBoundText } from "../reactor/textLayout";

type TextEl = ExcalidrawTextElement;

const MAX_CACHE = 2000;
/** Excalidraw's BOUND_TEXT_PADDING (not exported). */
const PADDING = 5;
const boundCache = new Map<string, { dx: number; dy: number; patch: Patch; grow: number }>();
const freeCache = new Map<string, { width: number; height: number; text: string }>();

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/** Excalidraw's `FONT_FAMILY` ids (part of the file format, so stable). */
const FAMILY_NAMES = new Map<number, string>([
  [1, "Virgil"],
  [2, "Helvetica"],
  [3, "Cascadia"],
  [5, "Excalifont"],
  [6, "Nunito"],
  [7, "Lilita One"],
  [8, "Comic Shanns"],
  [9, "Liberation Sans"],
]);
/** Families Excalidraw takes from the system rather than loading as web fonts. */
const LOCAL_FAMILIES = new Set(["Helvetica"]);

/**
 * Whether `text` in `style`'s font can be measured right now: the family's web font faces are
 * registered with `document.fonts` and loaded for these characters. Excalidraw only registers its
 * faces when it loads a scene's fonts, so an unregistered web family isn't ready either. True
 * when there's no `FontFaceSet` (tests) or the family is a system one.
 */
export function fontReady(style: Pick<TextEl, "fontFamily" | "fontSize">, text: string): boolean {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts || typeof fonts.check !== "function") return true;
  const family = FAMILY_NAMES.get(style.fontFamily);
  if (!family || LOCAL_FAMILIES.has(family)) return true;
  try {
    let registered = false;
    for (const face of fonts as unknown as Iterable<FontFace>)
      if (face.family.replace(/["']/g, "") === family) {
        registered = true;
        break;
      }
    return registered && fonts.check(`${style.fontSize}px "${family}"`, text || " ");
  } catch {
    return true;
  }
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
    hit = { dx: x as number, dy: y as number, patch: rest, grow: res.containerHeight };
    if (fontReady(style, text)) remember(boundCache, key, hit);
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
  const out = { width: t.width, height: t.height, text: t.text };
  return fontReady(style, text) ? remember(freeCache, key, out) : out;
}

/**
 * A fixed-width (`autoResize: false`) text element's text wrapped to `width`, and the height
 * it needs, the way Excalidraw wraps it: measured as the label of a probe container whose inner
 * width is `width` (Excalidraw pads bound text by 5 px each side).
 */
export function wrapFixedText(
  style: TextEl,
  text: string,
  width: number,
): { width: number; height: number; text: string } {
  const probe = { type: "rectangle", x: 0, y: 0, width: width + 2 * PADDING, height: 1, angle: 0 };
  const laid = layoutBoundText(probe as El, { ...style, verticalAlign: "top" } as TextEl, text);
  if (!laid) return { width, height: measureFreeText(style, text).height, text };
  return { width, height: laid.text.height as number, text: laid.text.text as string };
}
