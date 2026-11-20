/**
 * Contract for built-in desktop extensions (docs/extensions.md).
 *
 * An extension stores its *intent* in `element.customData[EXT_KEY]` (persisted in `.excalidraw`,
 * ignored by stock Excalidraw) and always produces *standard* output — ordinary element fields
 * and BinaryFiles — so the scene renders identically anywhere. The same definition drives the
 * app UI (presets) and the agent's MCP tools (`paramsSchema`).
 *
 * Shared contract with each extension module: fields may be added, never renamed or removed.
 */
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

/** `element.customData[EXT_KEY]` holds the {@link ExtensionIntent}. */
export const EXT_KEY = "excalidrawDesktop";

export type ExtensionIntent = {
  /** Extension id, e.g. "mask". */
  ext: string;
  /** Extension schema version. */
  v: number;
  params: Record<string, unknown>;
  /**
   * Whatever is needed to restore / re-derive (e.g. original fileId, width, height, crop).
   * Files the intent depends on MUST be named `source.fileId` or `source.fileIds` so the app keeps
   * them in saves, PNG exports and collab sync (see `sceneFileIds`).
   */
  source?: Record<string, unknown>;
  /** The output file this intent produced; a different `fileId` on the element means stale. */
  outputFileId?: FileId;
};

export interface ExtensionContext {
  getFile(id: FileId): BinaryFileData | undefined;
}

export interface ExtensionResult {
  /** Same id, updated (customData set/cleared by the extension). */
  element: ExcalidrawElement;
  /** New files to register via `addFiles`. */
  files: BinaryFileData[];
}

export interface ExtensionPreset<P> {
  id: string;
  label: string;
  params: P;
}

export interface DesktopExtension<P = Record<string, unknown>> {
  id: string;
  version: number;
  /** Human title, e.g. "Mask". */
  title: string;
  /** Optional one-line description for the agent (falls back to `title`). */
  description?: string;
  appliesTo(el: ExcalidrawElement): boolean;
  /** JSON Schema for `params` (embedded in the MCP tool schemas). */
  paramsSchema: Record<string, unknown>;
  /** UI actions, e.g. Circle. */
  presets: ExtensionPreset<P>[];
  /** The stored intent, or null when not applied or stale. */
  getIntent(el: ExcalidrawElement): ExtensionIntent | null;
  apply(el: ExcalidrawElement, params: P, ctx: ExtensionContext): Promise<ExtensionResult>;
  remove(el: ExcalidrawElement, ctx: ExtensionContext): Promise<ExtensionResult>;
}

/** Registry-erased form (params are validated against `paramsSchema` before `apply`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDesktopExtension = DesktopExtension<any>;
