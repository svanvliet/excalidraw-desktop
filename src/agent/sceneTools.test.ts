import { FakeApi } from "./scene/testHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { El } from "./scene/draft";
import { registerSceneTab, resetSceneBridge, setActiveSceneTab } from "./sceneBridge";
import { beginTurn, canRevertTurn, endTurn, revertTurn, runSceneTool } from "./sceneTools";
import { resetTurns } from "./scene/turns";
import ElkBundled from "elkjs/lib/elk.bundled.js";
import { setElkFactory } from "../layout/elk";
import { pathCrossesBox } from "../layout/route";
import type { ToolContent } from "./types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { Draft } from "./scene/draft";
import { createComponent } from "../extensions/components/actions";
import {
  __resetMyComponentsForTest,
  loadMyComponents,
  putMyComponent,
} from "../lib/componentLibraryStore";
import { masterToEntry } from "../components/componentsUi/libraryCodec";

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

  describe("add_image", () => {
    // 1x1 PNG with a 200x100 IHDR so sizing is observable.
    const png = (w = 200, h = 100) => {
      const b = new Uint8Array(33);
      b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      new DataView(b.buffer).setUint32(16, w);
      new DataView(b.buffer).setUint32(20, h);
      return btoa(String.fromCharCode(...b));
    };
    const svg = (body: string) => btoa(`<svg xmlns="http://www.w3.org/2000/svg" ${body}`);

    it("places inline data and registers the file", async () => {
      setup(boxes());
      const res = await call("add_image", { data: png(), mimeType: "image/png", x: 10, y: 20 });
      expect(res).toMatchObject({ x: 10, y: 20, width: 200, height: 100 });
      const el = api.byId(res.id);
      expect(el).toMatchObject({ type: "image", fileId: res.fileId, status: "saved" });
      expect(res.fileId).toMatch(/^[0-9a-f]{40}$/);
      expect(api.addFiles).toHaveBeenCalledWith([
        expect.objectContaining({
          id: res.fileId,
          mimeType: "image/png",
          dataURL: `data:image/png;base64,${png()}`,
        }),
      ]);
      expect(res.revision).toBeTypeOf("string");
    });

    it("keeps the aspect ratio when only one side is given and caps the default size", async () => {
      setup();
      const w = await call("add_image", { data: png(), mimeType: "image/png", width: 50 });
      expect(w).toMatchObject({ width: 50, height: 25 });
      const h = await call("add_image", { data: png(), mimeType: "image/png", height: 50 });
      expect(h).toMatchObject({ width: 100, height: 50 });
      const big = await call("add_image", { data: png(2000, 1000), mimeType: "image/png" });
      expect(big).toMatchObject({ width: 400, height: 200 });
      const sized = await call("add_image", {
        data: svg('viewBox="0 0 30 60"/>'),
        mimeType: "image/svg+xml",
      });
      expect(sized).toMatchObject({ width: 30, height: 60 });
    });

    it("fits inside a card or frame", async () => {
      setup([
        ...boxes(),
        ...scene([
          { type: "frame", id: "f", children: [], x: 1000, y: 0, width: 300, height: 300 },
        ]),
      ]);
      const card = await call("add_image", { data: png(), mimeType: "image/png", inside: "a" });
      // a is 100x60, padding 8 → 84x44 box; 2:1 image → 84x42, centred.
      expect(card).toMatchObject({ x: 8, y: 9, width: 84, height: 42 });
      expect(api.byId(card.id).frameId).toBeNull();
      const inFrame = await call("add_image", {
        data: png(),
        mimeType: "image/png",
        inside: "f",
        width: 100,
      });
      const f = api.byId("f");
      expect(inFrame).toMatchObject({ frameId: "f", width: 100, height: 50 });
      expect(inFrame.x).toBeCloseTo(f.x + (f.width - 100) / 2);
      expect(inFrame.y).toBeCloseTo(f.y + (f.height - 50) / 2);
      await expect(
        runSceneTool("add_image", { data: png(), mimeType: "image/png", inside: "nope" }, TAB),
      ).rejects.toThrow(/nope/);
    });

    it("rejects paths, bad types, mismatched bytes, oversized data and scripted SVG", async () => {
      setup();
      const reject = (args: Record<string, unknown>, re: RegExp) =>
        expect(runSceneTool("add_image", args, TAB)).rejects.toThrow(re);
      await reject({ path: "photo.png" }, /resolved by the app/);
      await reject({}, /Pass "path"/);
      await reject({ data: png(), mimeType: "image/bmp" }, /Unsupported image type/);
      await reject({ data: png() }, /mimeType/);
      await reject(
        { data: png(), mimeType: "image/gif" },
        /says image\/gif but the data is image\/png/,
      );
      await reject({ data: btoa("hello world"), mimeType: "image/png" }, /not a supported image/);
      await reject({ data: "!!!", mimeType: "image/png" }, /base64/);
      await reject({ data: "A".repeat(14_000_000), mimeType: "image/png" }, /10 MB/);
      await reject(
        { data: svg("><script>alert(1)</script></svg>"), mimeType: "image/svg+xml" },
        /<script>/,
      );
      await reject({ data: svg('onload="x()"/>'), mimeType: "image/svg+xml" }, /event handler/);
      await reject(
        {
          data: svg('><image href="https://evil.example/x.png"/></svg>'),
          mimeType: "image/svg+xml",
        },
        /link/,
      );
      await reject(
        { data: svg("><foreignObject/></svg>"), mimeType: "image/svg+xml" },
        /foreignObject/,
      );
      expect(api.calls).toHaveLength(0);
      expect(api.addFiles).not.toHaveBeenCalled();
    });

    it("works inside apply_ops atomically and reverts with the turn", async () => {
      setup(boxes());
      await expect(
        runSceneTool(
          "apply_ops",
          {
            ops: [
              { tool: "add_image", args: { data: png(), mimeType: "image/png", id: "ok" } },
              { tool: "add_image", args: { data: png(), mimeType: "image/gif" } },
            ],
          },
          TAB,
        ),
      ).rejects.toThrow(/op 1 \(add_image\) failed.*no changes were applied/);
      expect(api.calls).toHaveLength(0);

      beginTurn(TAB, "t1");
      const res = await call("apply_ops", {
        ops: [
          {
            tool: "add_image",
            args: { data: png(), mimeType: "image/png", id: "photo", inside: "a" },
          },
          { tool: "update_elements", args: { updates: [{ id: "a", patch: { x: 5 } }] } },
        ],
      });
      expect(res.results[0].id).toBe("photo");
      expect(api.byId("photo").isDeleted).toBe(false);
      endTurn(TAB, "t1");
      expect(revertTurn(TAB, "t1")).toMatchObject({ ok: true });
      expect(api.byId("photo").isDeleted).toBe(true);
      expect(api.byId("a").x).toBe(0);
    });
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

  it("find_elements filters by label text, regex, type and color", async () => {
    setup(boxes());
    expect(
      (await call("find_elements", { text: "alp" })).elements.map((e: { id: string }) => e.id),
    ).toEqual(["a"]);
    expect((await call("find_elements", { text: "^Al.*a$", regex: true })).total).toBe(1);
    expect((await call("find_elements", { types: ["ellipse", "diamond"] })).total).toBe(2);
    const red = await call("find_elements", { backgroundColor: "#FFC9C9" });
    expect(red.elements.map((e: { id: string }) => e.id)).toEqual(["c"]);
    await expect(runSceneTool("find_elements", { text: "(", regex: true }, TAB)).rejects.toThrow(
      /Invalid regex/,
    );
  });

  it("select_elements sets the user's selection without editing, even for viewers", async () => {
    setup(boxes());
    viewer = true;
    const labelId = api.byId("a").boundElements![0].id;
    expect((await call("select_elements", { ids: [labelId, "b"] })).selected).toEqual(["a", "b"]);
    expect((await call("select_elements", { ids: ["c"], mode: "add" })).selected).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect((await call("select_elements", { ids: ["a"], mode: "remove" })).selected).toEqual([
      "b",
      "c",
    ]);
    expect((await call("get_selection")).ids).toEqual(["b", "c"]);
    await call("select_elements", { mode: "clear", reveal: true });
    expect(api.selectedElementIds).toEqual({});
    expect(api.undoStack).toHaveLength(0);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("get_canvas_state and set_canvas", async () => {
    setup(boxes());
    api.appState = { viewBackgroundColor: "#ffffff", currentItemStrokeColor: "#1e1e1e" };
    const state = await call("get_canvas_state");
    expect(state).toMatchObject({
      elementCount: 3,
      editable: true,
      viewBackgroundColor: "#ffffff",
      currentItemStyle: { strokeColor: "#1e1e1e" },
      viewport: { x: 0, y: 0, width: 1000, height: 800, zoom: 1 },
    });
    await call("set_canvas", { viewBackgroundColor: "#fff9db", gridModeEnabled: true });
    expect(api.appState).toMatchObject({ viewBackgroundColor: "#fff9db", gridModeEnabled: true });
    expect(markDirty).toHaveBeenCalled();
    await expect(runSceneTool("set_canvas", {}, TAB)).rejects.toThrow(/Pass/);
  });

  it("move_elements shifts shapes with their labels and re-routes arrows", async () => {
    setup(boxes());
    await call("connect", { from: "a", to: "b" });
    const arrow = api.elements.find((e) => e.type === "arrow")!;
    const labelId = api.byId("a").boundElements!.find((b) => b.type === "text")!.id;
    const labelX = api.byId(labelId).x;
    await call("move_elements", { ids: ["a"], dx: 0, dy: 100 });
    expect(api.byId("a").y).toBe(100);
    expect(api.byId(labelId).x).toBe(labelX);
    expect(api.byId(labelId).y).toBeGreaterThan(100);
    expect(api.byId(arrow.id).version).toBeGreaterThan(arrow.version);
    await expect(runSceneTool("move_elements", { ids: ["a"] }, TAB)).rejects.toThrow(/non-zero/);
  });

  it("duplicate_elements copies labels, groups and internal arrows with remapped ids", async () => {
    setup(boxes());
    await call("connect", { from: "a", to: "b" });
    await call("connect", { from: "b", to: "c" });
    const { groupId } = await call("arrange", { ids: ["a", "b"], action: "group" });
    const { created } = await call("duplicate_elements", { ids: ["a", "b"], dx: 0, dy: 500 });
    const na = api.byId(created.a);
    const nb = api.byId(created.b);
    expect([na.x, na.y]).toEqual([api.byId("a").x, api.byId("a").y + 500]);
    expect(na.groupIds).toHaveLength(1);
    expect(na.groupIds[0]).not.toBe(groupId);
    expect(nb.groupIds).toEqual(na.groupIds);
    // Label copied and bound to the copy.
    const label = api.byId(na.boundElements!.find((b) => b.type === "text")!.id);
    expect((label as { containerId: string }).containerId).toBe(created.a);
    // Only the a→b arrow comes along (b→c has an end outside the copy).
    const arrows = Object.values(created as Record<string, string>)
      .map((id) => api.byId(id))
      .filter((e) => e.type === "arrow");
    expect(arrows).toHaveLength(1);
    const copied = arrows[0] as unknown as {
      startBinding: { elementId: string };
      endBinding: { elementId: string };
    };
    expect([copied.startBinding.elementId, copied.endBinding.elementId]).toEqual([
      created.a,
      created.b,
    ]);
    expect(nb.boundElements!.map((b) => b.id)).toContain(arrows[0].id);
    expect(api.undoStack).toHaveLength(4);
  });

  it("arrange frame puts elements into a frame and takes them out", async () => {
    setup([
      ...boxes(),
      ...scene([{ type: "frame", id: "f", x: -50, y: -50, width: 600, height: 600, children: [] }]),
    ]);
    await call("arrange", { ids: ["a", "b"], action: "frame", value: "f" });
    expect(api.byId("a").frameId).toBe("f");
    const labelId = api.byId("a").boundElements![0].id;
    expect(api.byId(labelId).frameId).toBe("f");
    expect((await call("find_elements", { frameId: "f" })).total).toBe(2);
    await call("move_elements", { ids: ["f"], dx: 10, dy: 0 });
    expect(api.byId("b").x).toBe(310);
    await call("arrange", { ids: ["a"], action: "frame", value: "none" });
    expect(api.byId("a").frameId).toBeNull();
    await expect(
      runSceneTool("arrange", { ids: ["a"], action: "frame", value: "b" }, TAB),
    ).rejects.toThrow(/not a frame/);
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
      ["move_elements", { ids: ["a"], dx: 5 }],
      ["duplicate_elements", { ids: ["a"] }],
      ["set_canvas", { viewBackgroundColor: "#000" }],
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

describe("auto_layout", () => {
  const chart = () =>
    scene([
      { type: "rectangle", id: "ceo", x: 400, y: 400, width: 120, height: 60 },
      { type: "rectangle", id: "cto", x: 0, y: 0, width: 120, height: 60 },
      { type: "rectangle", id: "cfo", x: 800, y: 50, width: 120, height: 60 },
      { type: "arrow", id: "a1", x: 0, y: 0, start: { id: "ceo" }, end: { id: "cto" } },
      { type: "arrow", id: "a2", x: 0, y: 0, start: { id: "ceo" }, end: { id: "cfo" } },
    ]);
  beforeEach(() => setElkFactory(async () => new ElkBundled()));
  afterEach(() => setElkFactory(null));

  it("lays out the canvas as one undo step", async () => {
    setup(chart());
    const res = await call("auto_layout", { algorithm: "tree", direction: "down" });
    expect(res).toMatchObject({ laidOut: 3, edges: 2 });
    expect(api.byId("ceo").y).toBeLessThan(api.byId("cto").y);
    expect(api.byId("cto").y).toBe(api.byId("cfo").y);
    expect(api.calls.map((c) => c.captureUpdate)).toEqual(["IMMEDIATELY"]);
    api.undo();
    expect(api.byId("ceo")).toMatchObject({ x: 400, y: 400 });
  });

  it("validates its options", async () => {
    setup(chart());
    await expect(runSceneTool("auto_layout", { direction: "sideways" }, TAB)).rejects.toThrow(
      /direction must be one of/,
    );
    await expect(runSceneTool("auto_layout", { spacing: -1 }, TAB)).rejects.toThrow(/spacing/);
    expect(api.calls).toHaveLength(0);
  });

  it("lays out shapes created earlier in the same apply_ops batch, within the agent turn", async () => {
    setup([]);
    beginTurn(TAB, "t1");
    const res = await call("apply_ops", {
      ops: [
        {
          tool: "add_elements",
          args: {
            elements: [
              { type: "rectangle", id: "p", x: 500, y: 500, width: 100, height: 50 },
              { type: "rectangle", id: "c1", x: 0, y: 0, width: 100, height: 50 },
              { type: "rectangle", id: "c2", x: 900, y: 0, width: 100, height: 50 },
            ],
          },
        },
        { tool: "connect", args: { from: "p", to: "c1" } },
        { tool: "connect", args: { from: "p", to: "c2" } },
        { tool: "auto_layout", args: { direction: "right", spacing: 40 } },
      ],
    });
    expect(res.results[3]).toMatchObject({ laidOut: 3, edges: 2 });
    expect(api.byId("p").x + 100).toBeLessThan(api.byId("c1").x);
    expect(api.byId("c1").x).toBe(api.byId("c2").x);
    expect(api.calls.map((c) => c.captureUpdate)).toEqual(["NEVER"]);
    endTurn(TAB, "t1");
    expect(api.undoStack).toHaveLength(1);
    api.undo();
    expect(api.elements.every((e) => e.isDeleted)).toBe(true);
  });

  it("re-runs the batch when the canvas changes while ELK is computing", async () => {
    setup(chart());
    let edited = false;
    setElkFactory(async () => {
      const elk = new ElkBundled();
      return {
        ...elk,
        layout: async (g: never) => {
          if (!edited) {
            edited = true;
            api.externalEdit("cfo", { backgroundColor: "#ffc9c9" });
          }
          return elk.layout(g);
        },
      } as never;
    });
    await call("auto_layout", {});
    expect(api.byId("cfo").backgroundColor).toBe("#ffc9c9");
    // Only the layout commit after the user's edit; the stale first attempt was dropped.
    expect(api.calls.map((c) => c.captureUpdate)).toEqual(["IMMEDIATELY"]);
    expect(api.byId("ceo").y).toBeLessThan(api.byId("cto").y);
  });
});

describe("tidy_arrows", () => {
  // A straight arrow from "top" to "bot" runs straight through "mid".
  const stack = () =>
    scene([
      { type: "rectangle", id: "top", x: 0, y: 0, width: 120, height: 60 },
      { type: "rectangle", id: "mid", x: 0, y: 200, width: 120, height: 60 },
      { type: "rectangle", id: "bot", x: 0, y: 400, width: 120, height: 60 },
      { type: "arrow", id: "a1", x: 0, y: 0, start: { id: "top" }, end: { id: "bot" } },
    ]);
  const absolute = (id: string) => {
    const el = api.byId(id) as unknown as { x: number; y: number; points: [number, number][] };
    return el.points.map(([x, y]) => [el.x + x, el.y + y] as [number, number]);
  };
  const midBox = { minX: 0, minY: 200, maxX: 120, maxY: 260 };

  it("routes around shapes as one undo step, converting when asked", async () => {
    setup(stack());
    const before = absolute("a1");
    await expect(runSceneTool("tidy_arrows", {}, TAB)).rejects.toThrow(/No elbow arrows/);
    const res = await call("tidy_arrows", { convert: true });
    expect(res).toMatchObject({ routed: ["a1"], skipped: [], converted: ["a1"] });
    expect(api.byId("a1")).toMatchObject({ elbowed: true });
    expect(pathCrossesBox(absolute("a1"), midBox)).toBe(false);
    expect(api.byId("mid")).toMatchObject({ x: 0, y: 200 });
    // A seeding commit (fields that were undefined, e.g. fixedSegments), then one undo step.
    expect(api.undoStack).toHaveLength(1);
    api.undo();
    expect(api.byId("a1")).toMatchObject({ elbowed: false });
    expect(absolute("a1")).toEqual(before);
  });

  it("validates convert", async () => {
    setup(stack());
    await expect(runSceneTool("tidy_arrows", { convert: "yes" }, TAB)).rejects.toThrow(/convert/);
  });

  it("works inside apply_ops", async () => {
    setup(stack().filter((e) => e.id !== "a1"));
    const res = await call("apply_ops", {
      ops: [
        { tool: "connect", args: { from: "top", to: "bot" } },
        { tool: "tidy_arrows", args: { convert: true } },
      ],
    });
    expect(res.results[1].routed).toHaveLength(1);
    const arrow = api.elements.find((e) => e.type === "arrow" && !e.isDeleted)!;
    expect(pathCrossesBox(absolute(arrow.id), midBox)).toBe(false);
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

describe("layer tools", () => {
  it("list_layers returns the tree rows; update_layer renames and locks a group in one undo step", async () => {
    setup(
      boxes().map((e) => (e.id === "b" || e.id === "c" ? ({ ...e, groupIds: ["g1"] } as El) : e)),
    );
    const before = await call("list_layers");
    expect(before.layers.map((r: { id: string; depth: number }) => [r.id, r.depth])).toEqual([
      ["g1", 0],
      ["c", 1],
      ["b", 1],
      ["a", 0],
    ]);
    expect(before.layers.find((r: { id: string }) => r.id === "a").label).toBe("Alpha");

    const res = await call("update_layer", { id: "g1", name: "Pair", locked: true });
    expect(res).toMatchObject({ updated: "g1", kind: "group" });
    expect(api.undoStack).toHaveLength(1);
    expect(api.byId("b").locked && api.byId("c").locked).toBe(true);
    const after = await call("list_layers");
    expect(after.layers[0]).toMatchObject({ id: "g1", name: "Pair", locked: true });
  });

  it("records a first customData write as {} → {...} so undo can revert it", async () => {
    setup(boxes());
    expect(api.byId("b").customData).toBeUndefined();
    await call("update_layer", { id: "b", name: "Logo" });
    expect(api.calls.map((c) => c.captureUpdate)).toEqual(["NEVER", "IMMEDIATELY"]);
    expect(api.undoStack).toHaveLength(1);
    expect(api.undoStack[0].get("b")!.before!.customData).toEqual({});

    beginTurn(TAB, "t1");
    await call("update_layer", { id: "c", name: "Box" });
    endTurn(TAB, "t1");
    expect(api.undoStack).toHaveLength(2);
    expect(api.undoStack[1].get("c")!.before!.customData).toEqual({});
  });

  it("update_layer is an apply_ops edit tool and validates its args", async () => {
    setup(boxes());
    await call("apply_ops", { ops: [{ tool: "update_layer", args: { id: "b", name: "Logo" } }] });
    expect(api.byId("b").customData).toEqual({ "excalidrawDesktop.layer": { v: 1, name: "Logo" } });
    await expect(runSceneTool("update_layer", { id: "b" }, TAB)).rejects.toThrow(/name.*locked/);
    await expect(runSceneTool("update_layer", { id: "zz", locked: true }, TAB)).rejects.toThrow(
      /No element or group/,
    );
  });
});

describe("shape data", () => {
  it("sets, replaces and removes data as one undo step each, visible to every read tool", async () => {
    setup(boxes());
    const res = await call("set_shape_data", {
      ids: ["a", "b"],
      set: { owner: "ann", cost: 3, done: false },
    });
    expect(res.updated).toEqual(["a", "b"]);
    expect(res.data.a).toEqual({ owner: "ann", cost: "3", done: "false" });
    expect(api.undoStack).toHaveLength(1);

    await call("set_shape_data", { ids: ["a"], set: { cost: null, owner: "bob" } });
    const summary = await call("get_scene_summary");
    const rowA = summary.elements.find((r: { id: string }) => r.id === "a");
    expect(rowA.data).toEqual({ owner: "bob", done: "false" });
    expect(summary.elements.find((r: { id: string }) => r.id === "c").data).toBeUndefined();

    const els = await call("get_elements", { ids: ["a", "c"] });
    expect(els.data).toEqual({ a: { owner: "bob", done: "false" } });

    const found = await call("find_elements", { dataKey: "owner", dataValue: "ann" });
    expect(found.elements.map((r: { id: string }) => r.id)).toEqual(["b"]);

    await call("set_shape_data", { ids: ["b"], set: { x: "1" }, replace: true });
    expect((await call("get_shape_data", { ids: ["b"] })).elements).toEqual([
      { id: "b", type: "ellipse", data: { x: "1" } },
    ]);
    expect(api.undoStack).toHaveLength(3);
    api.undo();
    expect((await call("get_shape_data", { ids: ["b"] })).elements[0].data).toEqual({
      owner: "ann",
      cost: "3",
      done: "false",
    });
  });

  it("lists every element with data, as JSON or CSV", async () => {
    setup(boxes());
    await call("set_shape_data", { ids: ["a"], set: { owner: "ann" } });
    await call("set_shape_data", { ids: ["c"], set: { cost: "=1+1" } });
    const all = await call("get_shape_data");
    expect(all.elements).toEqual([
      { id: "a", type: "rectangle", label: "Alpha", data: { owner: "ann" } },
      { id: "c", type: "diamond", data: { cost: "=1+1" } },
    ]);
    const csv = await call("get_shape_data", { format: "csv", ids: ["a", "c", "zz"] });
    expect(csv.csv).toBe(
      "id,type,label,owner,cost\r\na,rectangle,Alpha,ann,\r\nc,diamond,,,'=1+1\r\n",
    );
    expect(csv.missing).toEqual(["zz"]);
  });

  it("rejects bad input without changing anything", async () => {
    setup(boxes());
    await expect(call("set_shape_data", { ids: ["a"], set: { " ": "x" } })).rejects.toThrow(
      /empty/,
    );
    await expect(call("set_shape_data", { ids: ["a"], set: { k: {} } })).rejects.toThrow(/strings/);
    await expect(call("set_shape_data", { ids: ["a", "nope"], set: { k: "v" } })).rejects.toThrow(
      /nope/,
    );
    expect(api.undoStack).toHaveLength(0);
  });

  it("works inside apply_ops", async () => {
    setup(boxes());
    await call("apply_ops", {
      ops: [
        { tool: "set_shape_data", args: { ids: ["a"], set: { k: "1" } } },
        { tool: "set_shape_data", args: { ids: ["a"], set: { j: "2" } } },
      ],
    });
    expect((await call("get_shape_data", { ids: ["a"] })).elements[0].data).toEqual({
      k: "1",
      j: "2",
    });
    expect(api.undoStack).toHaveLength(1);
  });
});

describe("elbow anchors", () => {
  const fixed = (el: El | undefined, end: "startBinding" | "endBinding") =>
    (el as unknown as Record<string, { fixedPoint?: number[] } | null>)[end]?.fixedPoint;

  it("connect pins elbow ends and commits as one undo step", async () => {
    setup(boxes());
    const res = await call("connect", {
      from: "a",
      to: "b",
      startAnchor: "s",
      endAnchor: "center",
    });
    expect(res).toMatchObject({ elbow: true, startAnchor: "s", endAnchor: "w" });
    const arrow = api.elements.find((e) => e.id === res.id)!;
    expect(arrow).toMatchObject({ type: "arrow", elbowed: true });
    expect(fixed(arrow, "startBinding")).toEqual([0.5001, 1 + 5 / 60]);
    expect(api.undoStack).toHaveLength(1);
    expect(api.undoStack[0].get(res.id)?.before?.isDeleted ?? true).toBe(true);
    const row = (await call("get_scene_summary")).elements.find(
      (r: { id: string }) => r.id === res.id,
    );
    expect(row).toMatchObject({
      elbow: true,
      startAnchor: "s",
      endAnchor: "w",
      from: "a",
      to: "b",
    });
    // Plain connect stays a straight arrow.
    const plain = await call("connect", { from: "a", to: "c" });
    expect(plain.elbow).toBeUndefined();
    await expect(
      call("connect", { from: "a", to: "c", elbow: false, endAnchor: "n" }),
    ).rejects.toThrow(/need an elbow/);
  });

  it("set_arrow_anchors re-pins ends and rejects non-elbow arrows", async () => {
    setup(boxes());
    const { id } = await call("connect", { from: "a", to: "c", elbow: true });
    expect(await call("set_arrow_anchors", { id, start: "e", end: "n" })).toMatchObject({
      updated: 1,
      arrows: [{ id, elbow: true, startAnchor: "e", endAnchor: "n" }],
    });
    const arrow = api.elements.find((e) => e.id === id)!;
    expect(fixed(arrow, "startBinding")).toEqual([1.05, 0.5001]);
    expect(fixed(arrow, "endBinding")).toEqual([0.5001, -5 / 80]);
    expect(api.undoStack).toHaveLength(2);
    api.undo();
    expect(
      fixed(
        api.elements.find((e) => e.id === id),
        "startBinding",
      ),
    ).toEqual([0.5001, 1 + 5 / 60]);

    const plain = await call("connect", { from: "a", to: "b" });
    await expect(call("set_arrow_anchors", { id: plain.id, start: "n" })).rejects.toThrow(
      /not an elbow arrow/,
    );
    await expect(call("set_arrow_anchors", { id, start: "up" })).rejects.toThrow(/must be one of/);
  });

  it("folds anchored connects into the active turn", async () => {
    setup(boxes());
    beginTurn(TAB, "t1");
    await call("connect", { from: "a", to: "b", startAnchor: "n" });
    await call("connect", { from: "b", to: "c", endAnchor: "e" });
    expect(api.undoStack).toHaveLength(0);
    endTurn(TAB, "t1");
    expect(api.undoStack).toHaveLength(1);
  });
});

describe("component tools", () => {
  it("create, insert, sync via update_elements, overrides, reset, detach", async () => {
    setup(boxes());
    const made = await call("create_component", { ids: ["a"], name: "Card" });
    expect(made.componentId).toBeTruthy();
    expect(api.undoStack).toHaveLength(1);

    const inst = await call("insert_instance", { component: "a", x: 500, y: 200 });
    expect(inst.componentId).toBe(made.componentId);
    expect(inst.ids).toHaveLength(2); // rectangle + its label
    const [rect, label] = inst.ids.map((id: string) => api.byId(id));
    const instRect = rect.type === "rectangle" ? rect : label;
    const instText = rect.type === "text" ? rect : label;
    expect(instRect.x).toBe(500);
    expect(instText.text).toBe("Alpha");

    let list = (await call("list_components")).components;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Card", instances: [{ groupId: inst.groupId }] });

    // Editing the master through a generic tool syncs the instance in the same commit.
    const textId = api.byId("a").boundElements!.find((b) => b.type === "text")!.id;
    const steps = api.undoStack.length;
    await call("update_elements", {
      updates: [{ id: "a", patch: { backgroundColor: "#ffc9c9", width: 140 } }],
    });
    expect(api.undoStack.length).toBe(steps + 1);
    expect(api.byId(instRect.id)).toMatchObject({ backgroundColor: "#ffc9c9", width: 140 });

    // Overrides by slot (the master element id).
    await call("set_overrides", {
      instance: inst.groupId,
      overrides: [{ slot: textId, values: { text: "Beta" } }],
    });
    expect((api.byId(instText.id) as unknown as { text: string }).text).toBe("Beta");
    await call("update_elements", { updates: [{ id: textId, patch: { text: "Gamma" } }] });
    expect((api.byId(instText.id) as unknown as { text: string }).text).toBe("Beta");

    // A direct edit of an instance child's overridable key becomes an override; others revert.
    await call("update_elements", {
      updates: [{ id: instRect.id, patch: { strokeColor: "#1971c2", roughness: 2 } }],
    });
    expect(api.byId(instRect.id).strokeColor).toBe("#1971c2");
    expect(api.byId(instRect.id).roughness).toBe(api.byId("a").roughness);

    const summary = await call("get_scene_summary");
    const row = summary.elements.find((r: { id: string }) => r.id === instRect.id);
    expect(row.cmp).toMatchObject({
      id: made.componentId,
      role: "instance",
      group: inst.groupId,
      overrides: ["strokeColor"],
    });
    const got = await call("get_elements", { ids: [instText.id] });
    expect(got.components[instText.id]).toMatchObject({ role: "instance", slot: textId });

    await call("reset_overrides", { instance: instText.id });
    expect((api.byId(instText.id) as unknown as { text: string }).text).toBe("Gamma");
    expect(api.byId(instRect.id).strokeColor).toBe(api.byId("a").strokeColor);

    await expect(
      runSceneTool(
        "set_overrides",
        { instance: "a", overrides: [{ slot: "a", values: { text: "x" } }] },
        TAB,
      ),
    ).rejects.toThrow(/master, not an instance/);
    await expect(
      runSceneTool(
        "set_overrides",
        { instance: inst.groupId, overrides: [{ slot: "a", values: { roughness: 1 } }] },
        TAB,
      ),
    ).rejects.toThrow(/can't be overridden/);

    const det = await call("detach_instance", { instance: inst.groupId });
    expect(det.detached.ids).toHaveLength(2);
    list = (await call("list_components")).components;
    expect(list[0].instances).toHaveLength(0);
    await call("update_elements", { updates: [{ id: "a", patch: { backgroundColor: "#000" } }] });
    expect(api.byId(instRect.id).backgroundColor).toBe("#ffc9c9");
  });

  it("works inside apply_ops and is refused on a viewer tab", async () => {
    setup(boxes());
    const res = await call("apply_ops", {
      ops: [
        { tool: "create_component", args: { ids: ["b"] } },
        { tool: "insert_instance", args: { component: "b", x: 0, y: 300, scale: 2, angle: 90 } },
      ],
    });
    expect(api.undoStack).toHaveLength(1);
    const inst = res.results[1];
    const el = api.byId(inst.ids[0]);
    expect(el.width).toBe(200);
    expect(el.angle).toBeCloseTo(Math.PI / 2);
    viewer = true;
    await expect(runSceneTool("detach_instance", { instance: inst.groupId }, TAB)).rejects.toThrow(
      /view-only/,
    );
    expect((await call("list_components")).components).toHaveLength(1);
  });

  it("declares properties, sets values (one undo step each) and nests components", async () => {
    setup(boxes());
    const card = await call("create_component", { ids: ["a"], name: "Card" });
    const def = await call("define_property", {
      component: card.componentId,
      property: { name: "Title", type: "text", bindings: [{ elementId: "a" }] },
    });
    expect(def.propertyId).toBeTruthy();
    const inst = await call("insert_instance", { component: "a", x: 500, y: 0 });
    const undo = api.undoStack.length;
    const set = await call("set_properties", {
      instance: inst.groupId,
      values: { Title: "Hi" },
    });
    expect(set.values).toEqual({ [def.propertyId]: "Hi" });
    expect(api.undoStack).toHaveLength(undo + 1);
    const label = inst.ids
      .map((id: string) => api.byId(id))
      .find((e: { type: string }) => e.type === "text");
    expect((api.byId(label.id) as unknown as { text: string }).text).toBe("Hi");
    const summary = (await call("list_components")).components[0];
    expect(summary.props).toHaveLength(1);
    expect(summary.instances[0].values).toEqual({ [def.propertyId]: "Hi" });
    await expect(
      call("set_properties", { instance: inst.groupId, values: { Nope: "x" } }),
    ).rejects.toThrow(/property/i);

    // Nest a Card instance inside a Panel master; set the nested Title from a Panel instance.
    const panel = await call("create_component", { ids: ["b"], name: "Panel" });
    const nested = await call("insert_instance", {
      component: card.componentId,
      into: panel.masterGroupId,
      x: 300,
      y: 100,
    });
    await expect(
      call("insert_instance", { component: panel.componentId, into: card.masterGroupId }),
    ).rejects.toThrow(/cycle/);
    const pi = await call("insert_instance", { component: panel.componentId, x: 0, y: 500 });
    expect(pi.componentId).toBe(panel.componentId);
    expect(pi.ids).toHaveLength(3); // ellipse + nested card rect + label
    await call("set_properties", {
      instance: pi.groupId,
      nested: nested.groupId,
      values: { Title: "Deep" },
    });
    const texts = pi.ids
      .map((id: string) => api.byId(id))
      .filter((e: { type: string }) => e.type === "text");
    expect(texts.map((t: { text: string }) => t.text)).toEqual(["Deep"]);
    const comps = (await call("list_components")).components;
    expect(
      comps.find((c: { componentId: string }) => c.componentId === panel.componentId).uses,
    ).toEqual([card.componentId]);
    const rows = (await call("get_scene_summary")).elements;
    const nestedRect = pi.ids.find((id: string) => api.byId(id).type === "rectangle");
    expect(rows.find((r: { id: string }) => r.id === nestedRect).cmp).toMatchObject({
      id: panel.componentId,
      in: [card.componentId],
    });

    await call("remove_property", { component: card.componentId, property: "Title" });
    expect((api.byId(label.id) as unknown as { text: string }).text).toBe("Alpha");
  });
});

describe("container tools", () => {
  const stack = () =>
    scene([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 40 },
      { type: "rectangle", id: "b", x: 0, y: 100, width: 60, height: 60 },
      { type: "rectangle", id: "c", x: 400, y: 0, width: 50, height: 50 },
      { type: "arrow", id: "x", x: 60, y: 130, start: { id: "b" }, end: { id: "c" } },
    ]);

  it("create, re-flow generic edits, update order, add, take out, remove", async () => {
    setup(stack());
    const made = await call("create_container", { ids: ["a", "b"], gap: 10, padding: 0 });
    const box = made.containerId;
    expect(made.container).toMatchObject({ direction: "vertical", x: 0, y: 0, height: 110 });
    expect(api.byId("b").y).toBe(50);
    expect(api.undoStack).toHaveLength(1);

    // A generic edit to a child re-flows its container in the same commit; bound arrows follow.
    const arrowY = api.byId("x").y;
    await call("update_elements", { updates: [{ id: "a", patch: { height: 80 } }] });
    expect(api.byId("b").y).toBe(90);
    expect(api.byId("x").y).toBe(arrowY + 40);
    expect(api.byId(box).height).toBe(150);
    expect(api.undoStack).toHaveLength(2);

    await call("update_container", {
      containerId: "a",
      order: ["b", "a"],
      direction: "horizontal",
    });
    expect(api.byId("b")).toMatchObject({ x: 0, y: 0 });
    expect(api.byId("a").x).toBe(70);

    const added = await call("add_to_container", { containerId: box, ids: ["c"], index: 0 });
    expect(added.container.children.map((c: { key: string }) => c.key)).toEqual(["c", "b", "a"]);
    const listed = (await call("list_containers")).containers;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ containerId: box, width: 50 + 10 + 60 + 10 + 100 });

    await call("remove_from_container", { ids: ["c"] });
    expect(api.byId("c").groupIds).toEqual([]);
    expect(api.byId(box).width).toBe(170);

    await call("remove_container", { containerId: box });
    expect(api.byId(box).isDeleted).toBe(true);
    expect(api.byId("a").groupIds).toEqual([]);
    expect((await call("list_containers")).containers).toEqual([]);
  });

  it("works inside apply_ops and rejects bad settings", async () => {
    setup(stack());
    const res = await call("apply_ops", {
      ops: [
        { tool: "create_container", args: { ids: ["a", "b"], direction: "horizontal", gap: 0 } },
        { tool: "update_elements", args: { updates: [{ id: "a", patch: { width: 50 } }] } },
      ],
    });
    expect(api.undoStack).toHaveLength(1);
    // b's centre is further left, so it leads; a's new width re-flows the box.
    expect(api.byId("a").x).toBe(api.byId("b").x + 60);
    expect(api.byId(res.results[0].containerId).width).toBe(16 + 60 + 50 + 16);
    await expect(
      runSceneTool("update_container", { containerId: res.results[0].containerId, gap: -1 }, TAB),
    ).rejects.toThrow(/gap must be/);
    await expect(runSceneTool("update_container", { containerId: "c" }, TAB)).rejects.toThrow(
      /not a smart container/,
    );
  });
});

describe("style tools", () => {
  it("create, list, update live, direct edits become overrides, reset, unlink, delete", async () => {
    setup(boxes());
    const made = await call("create_style", {
      ids: ["a", "b"],
      name: "Primary",
      props: { strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "solid" },
    });
    expect(made.styleId).toBeTruthy();
    expect(api.undoStack).toHaveLength(1);
    expect(api.byId("b").backgroundColor).toBe("#a5d8ff");

    let list = (await call("list_styles")).styles;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Primary" });
    expect(list[0].elementIds).toEqual(expect.arrayContaining(["a", "b"]));

    await call("update_style", { style: "primary", props: { backgroundColor: "#ffc9c9" } });
    expect(api.byId("a").backgroundColor).toBe("#ffc9c9");
    expect(api.byId("b").backgroundColor).toBe("#ffc9c9");

    // A direct edit to a styled element becomes a local override, kept across style edits.
    await call("update_elements", { updates: [{ id: "b", patch: { strokeColor: "#e03131" } }] });
    await call("update_style", { style: made.styleId, props: { strokeColor: "#2f9e44" } });
    expect(api.byId("a").strokeColor).toBe("#2f9e44");
    expect(api.byId("b").strokeColor).toBe("#e03131");
    const summary = await call("get_scene_summary");
    const rowB = summary.elements.find((r: { id: string }) => r.id === "b");
    expect(rowB.sty).toEqual({ id: made.styleId, ov: ["strokeColor"] });
    expect((await call("get_elements", { ids: ["b"] })).styles.b).toMatchObject({
      styleId: made.styleId,
      name: "Primary",
    });

    expect((await call("reset_style_overrides", { ids: ["b"] })).reset).toBe(1);
    expect(api.byId("b").strokeColor).toBe("#2f9e44");

    await call("apply_style", { ids: ["b"], style: null });
    await call("update_style", { style: made.styleId, props: { backgroundColor: "#ffec99" } });
    expect(api.byId("b").backgroundColor).toBe("#ffc9c9");
    expect(api.byId("a").backgroundColor).toBe("#ffec99");

    const del = await call("delete_style", { style: "Primary" });
    expect(del).toMatchObject({ styleId: made.styleId, unlinked: 2 }); // a + its label
    list = (await call("list_styles")).styles;
    expect(list).toHaveLength(0);
    expect(api.byId("a").backgroundColor).toBe("#ffec99");
  });

  it("styles a component master and its instance follows; instance children can't be styled", async () => {
    setup(boxes());
    await call("create_component", { ids: ["a"], name: "Card" });
    const inst = await call("insert_instance", { component: "a", x: 500, y: 200 });
    const instRect = inst.ids.map((id: string) => api.byId(id)).find((e: El) => e.type !== "text");
    await expect(
      runSceneTool("create_style", { ids: [instRect.id], props: { opacity: 50 } }, TAB),
    ).rejects.toThrow(/style the master/);

    const made = await call("apply_ops", {
      ops: [
        { tool: "create_style", args: { ids: ["a"], props: { backgroundColor: "#b2f2bb" } } },
        { tool: "update_style", args: { style: "Style 1", props: { strokeWidth: 4 } } },
      ],
    });
    expect(made.results[0].styleId).toBeTruthy();
    expect(api.byId(instRect.id).backgroundColor).toBe("#b2f2bb");
    expect(api.byId(instRect.id).strokeWidth).toBe(4);
    // Propagated from the master, not an instance override.
    const comps = (await call("list_components")).components;
    expect(comps[0].instances[0].overriddenSlots ?? 0).toBe(0);
    const row = (await call("get_scene_summary")).elements.find(
      (r: { id: string }) => r.id === instRect.id,
    );
    expect(row.cmp.overrides).toBeUndefined();
    expect(row.sty).toMatchObject({ fromMaster: true });
  });

  it("rejects bad props and unknown styles", async () => {
    setup(boxes());
    await expect(
      runSceneTool("create_style", { ids: ["a"], props: { opacity: 500 } }, TAB),
    ).rejects.toThrow();
    await expect(runSceneTool("apply_style", { ids: ["a"], style: "Nope" }, TAB)).rejects.toThrow();
  });
});

describe("My components tools", () => {
  afterEach(() => __resetMyComponentsForTest());

  it("lists My components and inserts one with its image as one undo step", async () => {
    __resetMyComponentsForTest();
    const file = {
      id: "photo1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,iVBORw0KGgo=",
      created: 1,
    } as BinaryFileData;
    const src = new Draft(
      scene([
        { type: "rectangle", id: "card", x: 0, y: 0, width: 200, height: 120 },
        { type: "image", id: "pic", x: 10, y: 10, width: 60, height: 60, fileId: "photo1" },
        { type: "text", id: "who", x: 80, y: 30, text: "Ada" },
      ]),
    );
    const made = createComponent(src, ["card", "pic", "who"], "Person");
    await loadMyComponents();
    await putMyComponent(masterToEntry(src.toArray(), { photo1: file }, made.componentId));

    setup(boxes());
    const list = await call("list_my_components");
    expect(list.components).toEqual([
      expect.objectContaining({ id: made.componentId, name: "Person", elements: 3, images: 1 }),
    ]);

    const out = await call("insert_my_component", { component: "person" });
    expect(out).toMatchObject({ componentId: made.componentId, images: 1 });
    expect(out.ids).toHaveLength(3);
    expect(api.undoStack).toHaveLength(1);
    expect(api.addFiles).toHaveBeenCalledWith([expect.objectContaining({ id: "photo1" })]);
    const img = out.ids.map((id: string) => api.byId(id)).find((e: El) => e.type === "image");
    expect(img.fileId).toBe("photo1");
    // Default spot: right of the existing content.
    expect(Math.min(...out.ids.map((id: string) => api.byId(id).x))).toBeGreaterThan(400);

    await expect(call("insert_my_component", { component: "nope" })).rejects.toThrow(
      /not in My components/,
    );
  });
});
