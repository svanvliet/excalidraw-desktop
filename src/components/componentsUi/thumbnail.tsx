/**
 * Component thumbnails: `exportToSvg` of the elements, cached by (key, element versions, theme).
 * The SVG node is inserted inline (not as an <img>) so its text uses the editor's loaded fonts,
 * which is why font inlining is skipped.
 */
import { exportToSvg, hashElementsVersion } from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { useEffect, useRef } from "react";
import type { El } from "../../agent/scene/draft";
import { log } from "../../lib/logger";

const MAX_CACHED = 200;
const cache = new Map<string, Promise<SVGSVGElement | null>>();

/** Cached thumbnail SVG for `elements` (null if it can't be drawn). */
function thumbnailSvg(
  key: string,
  elements: readonly El[],
  files: BinaryFiles | undefined,
  dark: boolean,
): Promise<SVGSVGElement | null> {
  const id = `${key}:${hashElementsVersion(elements)}:${dark ? "d" : "l"}`;
  let hit = cache.get(id);
  if (hit) {
    // Refresh recency.
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const made: Promise<SVGSVGElement | null> = exportToSvg({
    elements: elements.filter((e) => !e.isDeleted),
    appState: { exportBackground: false, exportWithDarkMode: dark },
    files: files ?? null,
    exportPadding: 4,
    skipInliningFonts: true,
  }).catch((err: unknown) => {
    log.warn("components: thumbnail failed", err);
    return null;
  });
  cache.set(id, made);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return made;
}

export function ComponentThumb({
  thumbKey,
  elements,
  files,
  dark,
}: {
  thumbKey: string;
  elements: readonly El[];
  files?: BinaryFiles;
  dark: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void thumbnailSvg(thumbKey, elements, files, dark).then((svg) => {
      const host = ref.current;
      if (!live || !host) return;
      if (!svg) return host.replaceChildren();
      const copy = svg.cloneNode(true) as SVGSVGElement;
      copy.removeAttribute("width");
      copy.removeAttribute("height");
      copy.setAttribute("aria-hidden", "true");
      host.replaceChildren(copy);
    });
    return () => {
      live = false;
    };
  }, [thumbKey, elements, files, dark]);
  return <div ref={ref} className="desktop-components__thumb" aria-hidden="true" />;
}
