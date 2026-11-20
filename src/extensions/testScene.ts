/** Shared fixtures for extension unit tests (pair with the ./testRaster mock). */
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import type { ExtensionContext } from "./types";

export const SRC = "srcfile" as FileId;

export function testImage(over: Partial<ExcalidrawImageElement> = {}): ExcalidrawImageElement {
  return {
    id: "img1",
    type: "image",
    x: 10,
    y: 20,
    width: 200,
    height: 100,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 3,
    versionNonce: 1,
    index: null,
    isDeleted: false,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
    fileId: SRC,
    status: "saved",
    scale: [1, 1],
    crop: null,
    ...over,
  } as ExcalidrawImageElement;
}

/** A file map holding a 400×200 source (size read by testRaster from the data URL). */
export function testScene() {
  const files = new Map<string, BinaryFileData>([
    [
      SRC,
      {
        id: SRC,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,orig-400x200" as DataURL,
        created: 0,
      },
    ],
  ]);
  const ctx: ExtensionContext = { getFile: (id) => files.get(id) };
  const add = (fs: BinaryFileData[]) => fs.forEach((f) => files.set(f.id, f));
  return { files, ctx, add };
}

export const asImage = (el: ExcalidrawElement) => el as ExcalidrawImageElement;
