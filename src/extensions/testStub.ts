/**
 * Test-only extension mirroring the mask's shape: on image elements, `apply` swaps in a derived
 * file and records the original as `source`; `remove` restores it. Stale when the element's
 * `fileId` no longer matches `outputFileId`.
 */
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import { EXT_KEY, type DesktopExtension, type ExtensionIntent } from "./types";

export interface StubParams {
  color: string;
}

type Img = ExcalidrawElement & { fileId: FileId | null };

function withCustom(el: ExcalidrawElement, intent: ExtensionIntent | null): ExcalidrawElement {
  const customData = { ...(el.customData ?? {}) };
  if (intent) customData[EXT_KEY] = intent;
  else delete customData[EXT_KEY];
  return { ...el, customData } as ExcalidrawElement;
}

export const stubExtension: DesktopExtension<StubParams> = {
  id: "stub",
  version: 1,
  title: "Stub",
  appliesTo: (el) => el.type === "image",
  paramsSchema: {
    type: "object",
    properties: { color: { type: "string", enum: ["red", "blue"] } },
    required: ["color"],
    additionalProperties: false,
  },
  presets: [
    { id: "red", label: "Red", params: { color: "red" } },
    { id: "blue", label: "Blue", params: { color: "blue" } },
  ],
  getIntent(el) {
    const intent = (el.customData as Record<string, ExtensionIntent> | undefined)?.[EXT_KEY];
    if (!intent || intent.ext !== "stub") return null;
    return (el as Img).fileId === intent.outputFileId ? intent : null;
  },
  async apply(el, params, ctx) {
    const prev = this.getIntent(el);
    const sourceId = (prev?.source?.fileId as FileId | undefined) ?? (el as Img).fileId!;
    const src = ctx.getFile(sourceId);
    if (!src) throw new Error(`missing file ${sourceId}`);
    const outId = `${sourceId}-${params.color}` as FileId;
    return {
      element: withCustom({ ...el, fileId: outId } as ExcalidrawElement, {
        ext: "stub",
        v: 1,
        params: { ...params },
        source: { fileId: sourceId },
        outputFileId: outId,
      }),
      files: [{ ...src, id: outId, dataURL: `${src.dataURL}#${params.color}` as never }],
    };
  },
  async remove(el) {
    const intent = this.getIntent(el)!;
    return {
      element: withCustom(
        { ...el, fileId: intent.source!.fileId as FileId } as ExcalidrawElement,
        null,
      ),
      files: [],
    };
  },
};
