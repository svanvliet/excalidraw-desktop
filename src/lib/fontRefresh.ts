/**
 * Re-render text once web fonts finish loading.
 *
 * Excalidraw caches each text element's rendered canvas and only invalidates it when
 * `Fonts.onLoaded` sees a font face it hasn't recorded yet. That record is a static set
 * shared by every <Excalidraw> instance, so when several tabs are open, a tab that painted
 * before its font arrived can keep the fallback (serif) glyphs until something forces a
 * repaint, such as a window resize. Handing Excalidraw fresh object identities for the text
 * elements misses its per-element cache (a WeakMap) without bumping versions, so the scene
 * isn't marked dirty and nothing is broadcast to collaborators.
 */

interface TextLike {
  type: string;
}

export interface FontRefreshApi<E extends TextLike> {
  getSceneElementsIncludingDeleted(): readonly E[];
  updateScene(scene: { elements: E[]; captureUpdate: never }): void;
}

export function refreshTextElements<E extends TextLike>(
  api: FontRefreshApi<E>,
  captureNever: unknown,
): boolean {
  const elements = api.getSceneElementsIncludingDeleted();
  if (!elements.some((el) => el.type === "text")) return false;
  api.updateScene({
    elements: elements.map((el) => (el.type === "text" ? { ...el } : el)),
    captureUpdate: captureNever as never,
  });
  return true;
}

/**
 * Refresh text after the document's pending font loads settle and whenever another batch
 * of font faces finishes loading. Returns a cleanup function.
 */
export function watchFontLoads(refresh: () => void, fonts: FontFaceSet | undefined): () => void {
  if (!fonts) return () => {};
  let disposed = false;
  let frame = 0;
  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!disposed) refresh();
    });
  };
  // Excalidraw starts loading the scene's fonts after mount, so wait a tick before `ready`.
  const timer = setTimeout(() => {
    void fonts.ready.then(schedule);
  }, 0);
  fonts.addEventListener("loadingdone", schedule);
  return () => {
    disposed = true;
    clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    fonts.removeEventListener("loadingdone", schedule);
  };
}
