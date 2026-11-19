import { FakeApi } from "./scene/testHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { El } from "./scene/draft";
import { registerSceneTab, resetSceneBridge, setActiveSceneTab } from "./sceneBridge";
import { beginTurn, canRevertTurn, endTurn, revertTurn, runSceneTool } from "./sceneTools";
import { resetTurns } from "./scene/turns";
import type { ToolContent } from "./types";

vi.mock("@excalidraw/excalidraw", async (orig) => ({
  ...(await orig<typeof import("@excalidraw/excalidraw")>()),
  exportToBlob: vi.fn(async () => ({
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
  })),
}));

const parseMermaid = vi.fn();
vi.mock("@excalidraw/mermaid-to-excalidraw", () => ({
  parseMermaidToExcalidraw: (...a: unknown[]) => parseMermaid(...a),
}));

const TAB = "tab-1";
let api: FakeApi;
let viewer = false;
const markDirty = vi.fn();

function scene(skeletons: Array<Record<string, unknown>>): El[] {
  return convertToExcalidrawElements(skeletons as unknown as ExcalidrawElementSkeleton[], {
    regenerateIds: false,
  });
}

function setup(elements: El[] = []) {
  api = new FakeApi(elements);
  registerSceneTab(TAB, {
    api,
    title: () => "Diagram.excalidraw",
    isViewer: () => viewer,
    markDirty,
  });
  setActiveSceneTab(TAB);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(content: ToolContent[]): any {
  const text = content.find((c) => c.type === "text");
  return text && text.type === "text" ? JSON.parse(text.text) : undefined;
}

async function call(tool: string, args: Record<string, unknown> = {}) {
  return parse(await runSceneTool(tool, args, TAB));
}

const boxes = () =>
  scene([
    { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60, label: { text: "Alpha" } },
    { type: "ellipse", id: "b", x: 300, y: 0, width: 100, height: 60 },
    { type: "diamond", id: "c", x: 0, y: 300, width: 80, height: 80, backgroundColor: "#ffc9c9" },
  ]);

beforeEach(() => {
  viewer = false;
  markDirty.mockClear();
  parseMermaid.mockReset();
});
afterEach(() => {
  resetSceneBridge();
  resetTurns();
});

describe("read tools", () => {
  it("lists tabs with editability", async () => {
    setup(boxes());
    viewer = true;
    const res = parse(await runSceneTool("list_tabs", {}));
    expect(res.tabs).toEqual([
      { tabId: TAB, title: "Diagram.excalidraw", elementCount: 4, editable: false, active: true },
    ]);
  });

  it("summarizes compactly, folding labels into their container", async () => {
    setup(boxes());
    const res = await call("get_scene_summary");
    expect(res.total).toBe(3);
    expect(res.revision).toMatch(/^-?\d+$/);
    expect(res.bounds).toEqual({ x: 0, y: 0, width: 400, height: 380 });
    const a = res.elements.find((r: { id: string }) => r.id === "a");
    expect(a).toMatchObject({ type: "rectangle", x: 0, y: 0, w: 100, h: 60, label: "Alpha" });
    expect(a.labelId).toBeTypeOf("string");
    expect(a.stroke).toBeUndefined();
    expect(res.elements.find((r: { id: string }) => r.id === "c").bg).toBe("#ffc9c9");
  });

  it("paginates with a cursor and filters by bbox and ids", async () => {
    setup(boxes());
    const p1 = await call("get_scene_summary", { limit: 2 });
    expect(p1.elements.map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
    expect(p1.nextCursor).toBe("2");
    const p2 = await call("get_scene_summary", { limit: 2, cursor: p1.nextCursor });
    expect(p2.elements.map((r: { id: string }) => r.id)).toEqual(["c"]);
    expect(p2.nextCursor).toBeUndefined();

    const bbox = await call("get_scene_summary", {
      bbox: { x: 250, y: -10, width: 200, height: 100 },
    });
    expect(bbox.elements.map((r: { id: string }) => r.id)).toEqual(["b"]);
    const ids = await call("get_scene_summary", { ids: ["c", "nope"] });
    expect(ids.elements.map((r: { id: string }) => r.id)).toEqual(["c"]);
    expect(ids.missing).toEqual(["nope"]);
  });

  it("returns selection and full element JSON", async () => {
    setup(boxes());
    api.selectedElementIds = { b: true };
    expect((await call("get_selection")).ids).toEqual(["b"]);
    const full = await call("get_elements", { ids: ["b", "zzz"] });
    expect(full.elements[0]).toMatchObject({
      id: "b",
      type: "ellipse",
      version: expect.any(Number),
    });
    expect(full.missing).toEqual(["zzz"]);
  });

  it("renders a PNG as an MCP image item", async () => {
    setup(boxes());
    const content = await runSceneTool("render_canvas_png", { scope: "ids", ids: ["a"] }, TAB);
    expect(content[0]).toEqual({ type: "image", data: "iVBORw==", mimeType: "image/png" });
    const opts = vi.mocked(exportToBlob).mock.calls[0][0];
    expect(opts.maxWidthOrHeight).toBe(1280);
    // The label travels with its container.
    expect(opts.elements.map((e: El) => e.type).sort()).toEqual(["rectangle", "text"]);
  });

  it("set_viewport scrolls without touching the scene", async () => {
    setup(boxes());
    await call("set_viewport", { ids: ["b"], zoom: 2 });
    expect(api.scrollToContent).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "b" })],
      expect.objectContaining({ fitToContent: true, minZoom: 2, maxZoom: 2 }),
    );
    expect(api.calls).toHaveLength(0);
  });
});

describe("edit tools", () => {
  it("rejects stale expectedRevision and accepts the current one", async () => {
    setup(boxes());
    const { revision } = await call("get_scene_summary");
    api.externalEdit("b", { x: 999 });
    await expect(
      runSceneTool(
        "update_elements",
        { expectedRevision: revision, updates: [{ id: "a", patch: { x: 5 } }] },
        TAB,
      ),
    ).rejects.toThrow(/Revision conflict.*get_scene_summary/);
    const fresh = (await call("get_scene_summary")).revision;
    const res = await call("update_elements", {
      expectedRevision: fresh,
      updates: [{ id: "a", patch: { x: 5 } }],
    });
    expect(res.updated).toEqual(["a"]);
    expect(res.revision).not.toBe(fresh);
    expect(markDirty).toHaveBeenCalled();
  });

  it("bumps versions, moves bound text and reroutes bound arrows", async () => {
    setup(boxes());
    await call("connect", { from: "a", to: "b" });
    const arrow = api.elements.find((e) => e.type === "arrow")!;
    const before = { a: api.byId("a"), label: api.elements.find((e) => e.type === "text")! };

    await call("update_elements", {
      updates: [{ id: "a", patch: { y: 200, strokeColor: "#e03131" } }],
    });
    const a = api.byId("a");
    expect(a.version).toBeGreaterThan(before.a.version);
    expect(a.versionNonce).not.toBe(before.a.versionNonce);
    expect(a).toMatchObject({ y: 200, strokeColor: "#e03131" });
    const label = api.byId(before.label.id);
    expect(label.y - before.label.y).toBeCloseTo(200);
    const moved = api.byId(arrow.id);
    expect(moved.version).toBeGreaterThan(arrow.version);
    expect(moved.y).toBeGreaterThan(arrow.y + 100); // start now hangs off the moved box
  });

  it("updates and creates labels, rejects unknown fields", async () => {
    setup(boxes());
    await call("update_elements", {
      updates: [{ id: "b", patch: { text: "Beta", fontFamily: "Nunito" } }],
    });
    const b = api.byId("b");
    const label = api.byId(b.boundElements![0].id);
    expect(label).toMatchObject({
      type: "text",
      text: "Beta",
      originalText: "Beta",
      containerId: "b",
    });
    expect(label.width).toBeGreaterThan(0);
    // Centered in its container.
    expect(label.x + label.width / 2).toBeCloseTo(350);
    await expect(
      runSceneTool("update_elements", { updates: [{ id: "b", patch: { type: "text" } }] }, TAB),
    ).rejects.toThrow(/unsupported field/);
  });

  it("deletes as tombstones and cascades bound text and arrows", async () => {
    setup(boxes());
    const { id: arrowId, labelId } = await call("connect", { from: "a", to: "b", label: "calls" });
    const aLabel = api.byId("a").boundElements!.find((x) => x.type === "text")!.id;
    const res = await call("delete_elements", { ids: ["a"] });
    expect(new Set(res.deleted)).toEqual(new Set(["a", aLabel, arrowId, labelId]));
    for (const id of res.deleted) expect(api.byId(id).isDeleted).toBe(true);
    expect(api.byId("b").boundElements ?? []).toEqual([]);
    expect(api.byId("b").isDeleted).toBe(false);
  });

  it("add_elements keeps agent ids, rejects collisions and binds to existing elements", async () => {
    setup(boxes());
    await call("delete_elements", { ids: ["c"] });
    await expect(
      runSceneTool("add_elements", { elements: [{ type: "rectangle", id: "c", x: 0, y: 0 }] }, TAB),
    ).rejects.toThrow(/already exists/);
    await expect(
      runSceneTool(
        "add_elements",
        {
          elements: [
            { type: "rectangle", id: "n", x: 0, y: 0 },
            { type: "ellipse", id: "n", x: 1, y: 1 },
          ],
        },
        TAB,
      ),
    ).rejects.toThrow(/Duplicate id/);

    const res = await call("add_elements", {
      elements: [
        {
          type: "rectangle",
          id: "d",
          x: 300,
          y: 300,
          width: 120,
          height: 60,
          label: { text: "Delta" },
        },
        { type: "arrow", id: "ad", start: { id: "a" }, end: { id: "d" } },
        { type: "arrow", id: "bd", start: { id: "b" }, end: { id: "d" } },
      ],
    });
    expect(res.created.map((c: { id: string }) => c.id)).toEqual(["d", "ad", "bd"]);
    const ad = api.byId("ad");
    expect(ad).toMatchObject({
      startBinding: expect.objectContaining({ elementId: "a" }),
      endBinding: expect.objectContaining({ elementId: "d" }),
    });
    expect(api.byId("a").boundElements).toContainEqual({ id: "ad", type: "arrow" });
    expect(api.byId("d").boundElements).toEqual(
      expect.arrayContaining([
        { id: "ad", type: "arrow" },
        { id: "bd", type: "arrow" },
      ]),
    );
    await expect(
      runSceneTool("add_elements", { elements: [{ type: "arrow", start: { id: "ghost" } }] }, TAB),
    ).rejects.toThrow(/does not exist/);
  });

  it("connect binds both ends with endpoints on the shapes' outlines", async () => {
    setup(boxes());
    const { id } = await call("connect", {
      from: "a",
      to: "b",
      label: "next",
      style: { strokeStyle: "dashed" },
    });
    const arrow = api.byId(id) as El & { points: [number, number][] };
    expect(arrow.strokeStyle).toBe("dashed");
    expect(api.byId("a").boundElements).toContainEqual({ id, type: "arrow" });
    expect(api.byId("b").boundElements).toContainEqual({ id, type: "arrow" });
    const start = [arrow.x + arrow.points[0][0], arrow.y + arrow.points[0][1]];
    const last = arrow.points[arrow.points.length - 1];
    const end = [arrow.x + last[0], arrow.y + last[1]];
    expect(start[0]).toBeCloseTo(108); // a's right edge (100) + gap 8
    expect(start[1]).toBeCloseTo(30);
    expect(end[0]).toBeCloseTo(292); // b's left edge (300) - gap 8
    await expect(runSceneTool("connect", { from: "a", to: "a" }, TAB)).rejects.toThrow(/different/);
  });

  it("add_mermaid converts the diagram and reports image fallback", async () => {
    setup(boxes());
    parseMermaid.mockResolvedValueOnce({
      elements: [
        { type: "rectangle", id: "m1", x: 0, y: 0, width: 80, height: 40, label: { text: "A" } },
        { type: "rectangle", id: "m2", x: 0, y: 100, width: 80, height: 40, label: { text: "B" } },
        {
          type: "arrow",
          x: 40,
          y: 40,
          points: [
            [0, 0],
            [0, 60],
          ],
          start: { id: "m1" },
          end: { id: "m2" },
        },
      ],
      files: {},
    });
    const res = await call("add_mermaid", { mermaid: "flowchart TD\n A-->B", x: 1000, y: 50 });
    expect(res.imageFallback).toBe(false);
    expect(res.ids).toHaveLength(3);
    const added = res.ids.map((id: string) => api.byId(id));
    expect(Math.min(...added.map((e: El) => e.x))).toBeCloseTo(1000);
    expect(Math.min(...added.map((e: El) => e.y))).toBeCloseTo(50);

    parseMermaid.mockResolvedValueOnce({
      elements: [{ type: "image", x: 0, y: 0, width: 100, height: 100, fileId: "f1" }],
      files: {
        f1: {
          id: "f1",
          mimeType: "image/svg+xml",
          dataURL: "data:image/svg+xml;base64,AA==",
          created: 1,
        },
      },
    });
    const img = await call("add_mermaid", { mermaid: "gantt\n title x" });
    expect(img.imageFallback).toBe(true);
    expect(api.addFiles).toHaveBeenCalledWith([expect.objectContaining({ id: "f1" })]);

    parseMermaid.mockRejectedValueOnce(new Error("Syntax error"));
    await expect(runSceneTool("add_mermaid", { mermaid: "nope" }, TAB)).rejects.toThrow(
      /Mermaid parse failed/,
    );
  });

  it("arranges: align, grid, group/ungroup, z-order", async () => {
    setup(boxes());
    await call("arrange", { ids: ["a", "b", "c"], action: "align", value: "left" });
    expect(["a", "b", "c"].map((id) => api.byId(id).x)).toEqual([0, 0, 0]);

    await call("arrange", { ids: ["a", "b", "c"], action: "grid", columns: 3, gap: 20 });
    expect(["a", "b", "c"].map((id) => api.byId(id).x)).toEqual([0, 120, 240]);
    expect(["a", "b", "c"].map((id) => api.byId(id).y)).toEqual([0, 0, 0]);

    const { groupId } = await call("arrange", { ids: ["a", "b"], action: "group" });
    expect(api.byId("a").groupIds).toEqual([groupId]);
    const labelId = api.byId("a").boundElements![0].id;
    expect(api.byId(labelId).groupIds).toEqual([groupId]);
    await call("arrange", { ids: ["a"], action: "ungroup" });
    expect(api.byId("b").groupIds).toEqual([]);

    await call("arrange", { ids: ["c"], action: "zorder", value: "back" });
    expect(api.elements[0].id).toBe("c");
    await expect(
      runSceneTool("arrange", { ids: ["a"], action: "align", value: "diagonal" }, TAB),
    ).rejects.toThrow(/must be one of/);
  });

  it("refuses every edit tool on a viewer tab", async () => {
    setup(boxes());
    viewer = true;
    for (const [tool, args] of [
      ["add_elements", { elements: [{ type: "rectangle", x: 0, y: 0 }] }],
      ["update_elements", { updates: [{ id: "a", patch: { x: 1 } }] }],
      ["delete_elements", { ids: ["a"] }],
      ["connect", { from: "a", to: "b" }],
      ["add_mermaid", { mermaid: "flowchart TD\nA-->B" }],
      ["arrange", { ids: ["a"], action: "zorder", value: "front" }],
      ["apply_ops", { ops: [{ tool: "delete_elements", args: { ids: ["a"] } }] }],
    ] as const) {
      await expect(runSceneTool(tool, args, TAB)).rejects.toThrow(/view-only/);
    }
    expect(api.calls).toHaveLength(0);
    // Reads still work.
    expect((await call("get_scene_summary")).total).toBe(3);
  });

  it("apply_ops is atomic: one commit on success, nothing on failure", async () => {
    setup(boxes());
    const before = api.elements;
    await expect(
      runSceneTool(
        "apply_ops",
        {
          ops: [
            { tool: "update_elements", args: { updates: [{ id: "a", patch: { x: 50 } }] } },
            { tool: "delete_elements", args: { ids: ["missing"] } },
          ],
        },
        TAB,
      ),
    ).rejects.toThrow(/op 1 \(delete_elements\) failed: .*no changes were applied/);
    expect(api.calls).toHaveLength(0);
    expect(api.elements).toBe(before);

    const res = await call("apply_ops", {
      ops: [
        {
          tool: "add_elements",
          args: { elements: [{ type: "rectangle", id: "e", x: 600, y: 0 }] },
        },
        { tool: "connect", args: { from: "b", to: "e" } },
        { tool: "update_elements", args: { updates: [{ id: "a", patch: { x: 50 } }] } },
      ],
    });
    expect(res.results).toHaveLength(3);
    expect(api.calls).toHaveLength(1);
    expect(api.undoStack).toHaveLength(1);
  });
});

describe("turns", () => {
  it("collapses a whole turn into one undo step, leaving user edits separate", async () => {
    setup(boxes());
    beginTurn(TAB, "t1");
    await call("update_elements", { updates: [{ id: "a", patch: { x: 40 } }] });
    await call("add_elements", { elements: [{ type: "rectangle", id: "new", x: 500, y: 500 }] });
    api.externalEdit("c", { x: -50 }); // user edit mid-turn (its own undo step in reality)
    await call("delete_elements", { ids: ["b"] });
    expect(api.calls.every((c) => c.captureUpdate === "NEVER")).toBe(true);
    expect(api.undoStack).toHaveLength(0);

    expect(endTurn(TAB, "t1")).toBeGreaterThanOrEqual(3);
    expect(api.undoStack).toHaveLength(1);
    expect(api.byId("a").x).toBe(40);

    api.undo();
    expect(api.byId("a").x).toBe(0);
    expect(api.byId("b").isDeleted).toBe(false);
    expect(api.byId("new").isDeleted).toBe(true);
    expect(api.byId("c").x).toBe(-50); // the user's edit is not part of the agent's turn
  });

  it("edits outside a turn are one undo step per tool call", async () => {
    setup(boxes());
    await call("update_elements", { updates: [{ id: "a", patch: { x: 40 } }] });
    await call("update_elements", { updates: [{ id: "b", patch: { x: 40 } }] });
    expect(api.calls.map((c) => c.captureUpdate)).toEqual(["IMMEDIATELY", "IMMEDIATELY"]);
    expect(api.undoStack).toHaveLength(2);
  });

  it("revertTurn restores the pre-turn scene with bumped versions", async () => {
    setup(boxes());
    beginTurn(TAB, "t1");
    await call("update_elements", {
      updates: [{ id: "a", patch: { x: 40, backgroundColor: "#a5d8ff" } }],
    });
    await call("add_elements", { elements: [{ type: "ellipse", id: "new", x: 500, y: 500 }] });
    await call("delete_elements", { ids: ["c"] });
    endTurn(TAB, "t1");
    expect(canRevertTurn(TAB, "t1")).toBe(true);
    const versionA = api.byId("a").version;

    // a + its label (moved along), new, c
    expect(revertTurn(TAB, "t1")).toEqual({ ok: true, reverted: 4 });
    expect(api.byId("a")).toMatchObject({ x: 0, backgroundColor: "transparent" });
    expect(api.byId("a").version).toBeGreaterThan(versionA);
    expect(api.byId("new").isDeleted).toBe(true);
    expect(api.byId("c").isDeleted).toBe(false);
    expect(api.calls[api.calls.length - 1]?.captureUpdate).toBe("IMMEDIATELY");
    expect(canRevertTurn(TAB, "t1")).toBe(false);
    expect(revertTurn(TAB, "t1")).toEqual({ ok: false, reason: "unknown" });
  });

  it("revertTurn reports conflicts with later edits unless forced", async () => {
    setup(boxes());
    beginTurn(TAB, "t1");
    await call("update_elements", { updates: [{ id: "a", patch: { x: 40 } }] });
    endTurn(TAB, "t1");
    api.externalEdit("a", { y: 77 });
    expect(revertTurn(TAB, "t1")).toEqual({ ok: false, reason: "conflict", ids: ["a"] });
    expect(revertTurn(TAB, "t1", { force: true })).toEqual({ ok: true, reverted: 2 });
    expect(api.byId("a").x).toBe(0);
  });

  it("revertTurn on an active turn ends it first", async () => {
    setup(boxes());
    beginTurn(TAB, "t2");
    await call("update_elements", { updates: [{ id: "b", patch: { y: 99 } }] });
    expect(revertTurn(TAB, "t2")).toEqual({ ok: true, reverted: 1 });
    expect(api.byId("b").y).toBe(0);
  });
});
