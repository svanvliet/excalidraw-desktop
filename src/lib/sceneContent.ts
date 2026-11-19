import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";

type OnChangeArgs = Parameters<NonNullable<ExcalidrawProps["onChange"]>>;
type VersionedElement = { version: number; versionNonce: number };

/**
 * Fingerprint of what ends up in a saved `.excalidraw` file. Excalidraw bumps
 * `version`/`versionNonce` on every element edit (including deletes), so a
 * running hash over them changes exactly when content does. Selection,
 * scroll, zoom and other view-only state are left out so they don't mark a
 * document as unsaved.
 */
export function sceneContentKey(
  elements: readonly VersionedElement[],
  appState: Pick<OnChangeArgs[1], "viewBackgroundColor">,
  files: OnChangeArgs[2] | Record<string, unknown>,
): string {
  let hash = 5381;
  for (const el of elements) {
    hash = (Math.imul(hash, 33) ^ el.version) | 0;
    hash = (Math.imul(hash, 33) ^ el.versionNonce) | 0;
  }
  const fileIds = Object.keys(files ?? {})
    .sort()
    .join(",");
  return `${hash >>> 0}|${elements.length}|${appState.viewBackgroundColor}|${fileIds}`;
}
