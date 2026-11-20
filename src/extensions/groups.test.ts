import { afterEach, describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { setExtensionsForTests } from "./registry";
import { stubExtension } from "./testStub";
import { borderExtension } from "./border";
import { EXT_KEY } from "./types";
import { extensionGroups, patchParams } from "./groups";

function image(id: string, chain?: { ext: string; params: unknown }[]): ExcalidrawElement {
  return {
    id,
    type: "image",
    width: 1,
    height: 1,
    fileId: chain ? `file-${id}-out` : `file-${id}`,
    customData: chain && {
      [EXT_KEY]: {
        v: 2,
        chain: chain.map((l) => ({ ...l, v: l.ext === "border" ? 2 : 1 })),
        source: {
          fileId: `file-${id}`,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          crop: null,
          appliedWidth: 1,
          appliedHeight: 1,
        },
        outputFileId: `file-${id}-out`,
      },
    },
  } as unknown as ExcalidrawElement;
}

const border = (params: Record<string, unknown>) => ({
  ext: "border",
  params: { width: 2, color: "#1e1e1e", opacity: 100, style: "solid", roughness: 0, ...params },
});

afterEach(() => setExtensionsForTests());

describe("extensionGroups", () => {
  it("marks presets active only when every target has them", () => {
    setExtensionsForTests([stubExtension]);
    const red = image("a", [{ ext: "stub", params: { color: "red" } }]);
    const [g] = extensionGroups([red, image("b")]);
    expect(g).toMatchObject({ id: "stub", ids: ["a", "b"], removable: true, common: {} });
    expect(g!.presets.map((p) => p.active)).toEqual([false, false]);
    expect(extensionGroups([red])[0]!.presets.map((p) => p.active)).toEqual([true, false]);
  });

  it("collects the params every target shares, and patches without resetting them", () => {
    setExtensionsForTests([borderExtension]);
    const a = image("a", [border({ color: "#e03131", style: "dashed", width: 4 })]);
    const b = image("b", [border({ color: "#e03131", style: "dotted", width: 4 })]);
    const [g] = extensionGroups([a, b]);
    expect(g!.common).toEqual({ width: 4, color: "#e03131", opacity: 100, roughness: 0 });
    expect(patchParams(g!, { roughness: 2 })).toEqual({
      width: 4,
      color: "#e03131",
      opacity: 100,
      // style differs, so it is left to the schema default (solid) at apply time
      roughness: 2,
    });
    // A target without a border means nothing is shared: start from the default preset.
    const [mixed] = extensionGroups([a, image("c")]);
    expect(mixed!.common).toEqual({});
    expect(patchParams(mixed!, { color: "#2f9e44" })).toMatchObject({ width: 2, color: "#2f9e44" });
  });
});
