// src/extensions/types.ts
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
export const EXT_KEY = "excalidrawDesktop"; // element.customData[EXT_KEY]
export type ExtensionIntent = {
  ext: string;
  v: number;
  params: Record<string, unknown>;
  source?: Record<string, unknown>;
  outputFileId?: FileId;
};
export interface ExtensionContext {
  getFile(id: FileId): BinaryFileData | undefined;
}
export interface ExtensionResult {
  element: ExcalidrawElement;
  files: BinaryFileData[];
}
export interface DesktopExtension<P = Record<string, unknown>> {
  id: string;
  version: number;
  title: string;
  appliesTo(el: ExcalidrawElement): boolean;
  paramsSchema: Record<string, unknown>;
  presets: { id: string; label: string; params: P }[];
  getIntent(el: ExcalidrawElement): ExtensionIntent | null;
  apply(el: ExcalidrawElement, params: P, ctx: ExtensionContext): Promise<ExtensionResult>;
  remove(el: ExcalidrawElement, ctx: ExtensionContext): Promise<ExtensionResult>;
}
