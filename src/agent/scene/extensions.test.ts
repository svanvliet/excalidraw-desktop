import { FakeApi } from "./testHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { El } from "./draft";
import { registerSceneTab, resetSceneBridge, setActiveSceneTab } from "../sceneBridge";
import { beginTurn, endTurn, revertTurn, runSceneTool } from "../sceneTools";
import { resetTurns } from "./turns";
import type { ToolContent } from "../types";
import { setExtensionsForTests } from "../../extensions/registry";
import { stubExtension } from "../../extensions/testStub";

const TAB = "tab-1";
let api: FakeApi;

function image(id: string, extra: Record<string, unknown> = {}): El {
  return {
    id,
    type: "image",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    fileId: `file-${id}`,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    groupIds: [],
    boundElements: null,
    frameId: null,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    ...extra,
  } as unknown as El;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(content: ToolContent[]): any {
  const text = content.find((c) => c.type === "text");
  return text && text.type === "text" ? JSON.parse(text.text) : undefined;
}

const call = async (tool: string, args: Record<string, unknown>) =>
  parse(await runSceneTool(tool, args, TAB));
const fileIdOf = (id: string) => (api.byId(id) as unknown as { fileId: string }).fileId;

beforeEach(() => {
  setExtensionsForTests([stubExtension]);
  api = new FakeApi([image("i1"), image("i2"), image("r", { type: "rectangle" })]);
  api.files = {
    "file-i1": { id: "file-i1", mimeType: "image/png", dataURL: "data:i1", created: 1 },
    "file-i2": { id: "file-i2", mimeType: "image/png", dataURL: "data:i2", created: 1 },
  };
  registerSceneTab(TAB, { api, title: () => "T", isViewer: () => false, markDirty: vi.fn() });
  setActiveSceneTab(TAB);
});
afterEach(() => {
  setExtensionsForTests();
  resetSceneBridge();
  resetTurns();
});

describe("extension agent tools", () => {
  it("apply_extension applies a preset, registers files and reports skipped targets", async () => {
    const res = await call("apply_extension", {
      ids: ["i1", "r"],
      extension: "stub",
      preset: "red",
    });
    expect(res.applied).toEqual(["i1"]);
    expect(res.skipped).toEqual([{ id: "r", reason: "Stub does not apply to a rectangle" }]);
    expect(fileIdOf("i1")).toBe("file-i1-red");
    expect(api.addFiles).toHaveBeenCalledWith([expect.objectContaining({ id: "file-i1-red" })]);
    expect(api.undoStack).toHaveLength(1);

    const summary = await call("get_scene_summary", {});
    const row = summary.elements.find((e: { id: string }) => e.id === "i1");
    expect(row.ext).toEqual({ stub: { color: "red" } });
    const got = await call("get_elements", { ids: ["i1", "i2"] });
    expect(got.extensions).toEqual({ i1: { applied: { stub: { color: "red" } }, stale: [] } });

    await call("remove_extension", { ids: ["i1"], extension: "stub" });
    expect(fileIdOf("i1")).toBe("file-i1");
  });

  it("validates extension, preset and params, and errors when nothing changes", async () => {
    await expect(
      runSceneTool("apply_extension", { ids: ["i1"], extension: "nope", preset: "red" }, TAB),
    ).rejects.toThrow(/Unknown extension "nope"/);
    await expect(
      runSceneTool(
        "apply_extension",
        { ids: ["i1"], extension: "stub", params: { color: 1 } },
        TAB,
      ),
    ).rejects.toThrow(/params.color must be string/);
    await expect(
      runSceneTool("remove_extension", { ids: ["i1"], extension: "stub" }, TAB),
    ).rejects.toThrow(/Stub changed nothing \(i1: Stub is not applied\)/);
  });

  it("reports stale intent in reads", async () => {
    await call("apply_extension", { ids: ["i1"], extension: "stub", preset: "blue" });
    api.externalEdit("i1", { fileId: "elsewhere" } as never);
    const summary = await call("get_scene_summary", { ids: ["i1"] });
    expect(summary.elements[0].ext).toBeUndefined();
    expect(summary.elements[0].extStale).toEqual(["stub"]);
  });

  it("works inside apply_ops atomically and folds into the agent turn", async () => {
    beginTurn(TAB, "t1");
    await call("apply_ops", {
      ops: [
        { tool: "apply_extension", args: { ids: ["i1"], extension: "stub", preset: "red" } },
        { tool: "move_elements", args: { ids: ["i2"], dx: 10, dy: 0 } },
      ],
    });
    await call("apply_extension", { ids: ["i2"], extension: "stub", preset: "blue" });
    endTurn(TAB, "t1");
    expect(api.undoStack).toHaveLength(1);
    expect(fileIdOf("i2")).toBe("file-i2-blue");

    expect(revertTurn(TAB, "t1")).toEqual({ ok: true, reverted: 2 });
    expect(fileIdOf("i1")).toBe("file-i1");
    expect(fileIdOf("i2")).toBe("file-i2");

    await expect(
      runSceneTool(
        "apply_ops",
        {
          ops: [
            { tool: "move_elements", args: { ids: ["i1"], dx: 10, dy: 0 } },
            { tool: "apply_extension", args: { ids: ["i1"], extension: "stub", preset: "red" } },
          ],
        },
        TAB,
      ),
    ).rejects.toThrow(/op 1 \(apply_extension\) failed: Element "i1" changed/);
    expect(fileIdOf("i1")).toBe("file-i1");
  });
});
