import { FakeApi } from "../agent/scene/testHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { setExtensionsForTests } from "./registry";
import { extensionStateOf, sceneFileIds } from "./stack";
import { resolveParams, runExtension } from "./runner";
import { validateSchema } from "./schema";
import { stubExtension } from "./testStub";
import { EXT_KEY } from "./types";

vi.mock("./raster", () => import("./testRaster"));

function image(id: string, fileId = `file-${id}`): ExcalidrawElement {
  return {
    id,
    type: "image",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    fileId,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    groupIds: [],
    customData: undefined,
  } as unknown as ExcalidrawElement;
}

let api: FakeApi;
beforeEach(() => {
  setExtensionsForTests([stubExtension]);
  api = new FakeApi([image("i1"), image("i2"), { ...image("r"), type: "rectangle" } as never]);
  api.files = {
    "file-i1": { id: "file-i1", mimeType: "image/png", dataURL: "data:i1", created: 1 },
    "file-i2": { id: "file-i2", mimeType: "image/png", dataURL: "data:i2", created: 1 },
  };
});
afterEach(() => setExtensionsForTests());

const fileIdOf = (id: string) => (api.byId(id) as unknown as { fileId: string }).fileId;

describe("runExtension", () => {
  it("applies to every applicable target as one undo step and registers files", async () => {
    const res = await runExtension(api, ["i1", "i2", "r"], "stub", {
      kind: "apply",
      params: { color: "red" },
    });
    expect(res.applied).toEqual(["i1", "i2"]);
    expect(res.skipped).toEqual([{ id: "r", reason: "Stub does not apply to a rectangle" }]);
    expect(api.undoStack).toHaveLength(1);
    expect(api.calls.map((c) => c.captureUpdate)).toEqual(["IMMEDIATELY"]);
    const out = fileIdOf("i1");
    expect(out).toMatch(/^[0-9a-f]{40}$/);
    expect(api.addFiles).toHaveBeenCalledWith([
      expect.objectContaining({ id: out }),
      expect.objectContaining({ id: fileIdOf("i2") }),
    ]);
    expect(api.byId("i1").version).toBeGreaterThan(1);
    expect(extensionStateOf(api.byId("i1"))).toEqual({
      applied: { stub: { color: "red" } },
      stale: [],
    });

    api.undo();
    expect(fileIdOf("i1")).toBe("file-i1");
  });

  it("re-applies from the stored source and removes back to it", async () => {
    await runExtension(api, ["i1"], "stub", { kind: "apply", params: { color: "red" } });
    const red = fileIdOf("i1");
    await runExtension(api, ["i1"], "stub", { kind: "apply", params: { color: "blue" } });
    expect(fileIdOf("i1")).not.toBe(red);
    expect(api.byId("i1").customData?.[EXT_KEY]).toMatchObject({
      v: 2,
      chain: [{ ext: "stub", v: 1, params: { color: "blue" } }],
      source: { fileId: "file-i1" },
    });
    const res = await runExtension(api, ["i1"], "stub", { kind: "remove" });
    expect(res.applied).toEqual(["i1"]);
    expect(fileIdOf("i1")).toBe("file-i1");
    expect(api.byId("i1").customData?.[EXT_KEY]).toBeUndefined();
    expect(api.undoStack).toHaveLength(3);
  });

  it("treats an element changed elsewhere as stale and leaves it alone on remove", async () => {
    await runExtension(api, ["i1"], "stub", { kind: "apply", params: { color: "red" } });
    api.externalEdit("i1", { fileId: "file-other" } as never);
    expect(extensionStateOf(api.byId("i1"))).toEqual({ applied: {}, stale: ["stub"] });
    const before = api.undoStack.length;
    const res = await runExtension(api, ["i1"], "stub", { kind: "remove" });
    expect(res).toEqual({ applied: [], skipped: [{ id: "i1", reason: "Stub is not applied" }] });
    expect(api.undoStack).toHaveLength(before);
    expect(fileIdOf("i1")).toBe("file-other");
  });

  it("keeps source files referenced and skips when the original is gone", async () => {
    await runExtension(api, ["i1"], "stub", { kind: "apply", params: { color: "red" } });
    const red = fileIdOf("i1");
    expect(sceneFileIds(api.elements as never)).toEqual([red, "file-i2", "file-i1"]);

    // e.g. reopened from a stock-Excalidraw save that dropped the unreferenced original.
    delete api.files["file-i1"];
    const res = await runExtension(api, ["i1"], "stub", { kind: "remove" });
    expect(res).toEqual({
      applied: [],
      skipped: [{ id: "i1", reason: "the original image for Stub is missing" }],
    });
    expect(fileIdOf("i1")).toBe(red);
  });

  it("skips elements edited while the extension ran", async () => {
    const slow = {
      ...stubExtension,
      // Runs after the async source load, i.e. while the extension is in flight.
      plan(plan: Parameters<NonNullable<typeof stubExtension.plan>>[0]) {
        api.externalEdit("i1", { x: 50 });
        return plan;
      },
    };
    setExtensionsForTests([slow]);
    const res = await runExtension(api, ["i1"], "stub", {
      kind: "apply",
      params: { color: "red" },
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toEqual([{ id: "i1", reason: "changed while the extension ran" }]);
    expect(api.byId("i1").x).toBe(50);
    expect(api.calls).toHaveLength(0);
  });

  it("rejects unknown extensions and invalid params", async () => {
    await expect(runExtension(api, ["i1"], "nope", { kind: "remove" })).rejects.toThrow(
      /Unknown extension/,
    );
    await expect(
      runExtension(api, ["i1"], "stub", { kind: "apply", params: { color: "green" } }),
    ).rejects.toThrow(/params.color must be one of/);
  });
});

describe("resolveParams", () => {
  it("merges preset params with overrides and validates", () => {
    expect(resolveParams(stubExtension, "red", undefined)).toEqual({ color: "red" });
    expect(resolveParams(stubExtension, "red", { color: "blue" })).toEqual({ color: "blue" });
    expect(() => resolveParams(stubExtension, "pink", undefined)).toThrow(/presets: red, blue/);
    expect(() => resolveParams(stubExtension, undefined, undefined)).toThrow(/preset/);
    expect(() => resolveParams(stubExtension, undefined, { color: "red", x: 1 })).toThrow(
      /params.x is not allowed/,
    );
  });
});

describe("validateSchema", () => {
  it("checks numbers, required keys, and oneOf", () => {
    const s = { type: "object", properties: { r: { type: "number", minimum: 0, maximum: 1 } } };
    expect(validateSchema(s, { r: 0.5 })).toBeNull();
    expect(validateSchema(s, { r: 2 })).toMatch(/<= 1/);
    expect(validateSchema({ ...s, required: ["r"] }, {})).toMatch(/params.r is required/);
    expect(validateSchema({ oneOf: [{ type: "string" }, { type: "number" }] }, true)).toMatch(
      /must be string/,
    );
  });
});
