// Integration check against the real Excalidraw Store/History (not FakeApi):
// a whole agent turn must collapse into exactly one undo step, and revertTurn
// must restore the pre-turn scene.
import "./scene/testHarness";
import { afterEach, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { registerSceneTab, resetSceneBridge } from "./sceneBridge";
import { beginTurn, endTurn, revertTurn, runSceneTool } from "./sceneTools";
import { resetTurns } from "./scene/turns";

const g = globalThis as Record<string, unknown>;
g.Path2D ??= class {
  addPath() {}
};
g.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(document as unknown as { fonts: { has?: () => boolean } }).fonts.has ??= () => true;

afterEach(() => {
  resetTurns();
  resetSceneBridge();
});

const TAB = "real";

function positions(api: ExcalidrawImperativeAPI) {
  return api
    .getSceneElements()
    .filter((e) => e.type !== "text")
    .map((e) => [e.id, e.x])
    .sort();
}

function undo() {
  const btn = document.querySelector<HTMLElement>('[aria-label="Undo"]');
  expect(btn).toBeTruthy();
  act(() => {
    fireEvent.click(btn!);
  });
}

it("collapses an agent turn into one undo step and reverts it", async () => {
  let api: ExcalidrawImperativeAPI | null = null;
  render(<Excalidraw excalidrawAPI={(a) => (api = a)} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  const ex = api as unknown as ExcalidrawImperativeAPI;
  expect(ex).toBeTruthy();
  registerSceneTab(TAB, {
    api: ex,
    title: () => "Real",
    isViewer: () => false,
    markDirty: () => {},
  });
  const seed = convertToExcalidrawElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50 },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
  act(() => ex.updateScene({ elements: seed, captureUpdate: CaptureUpdateAction.IMMEDIATELY }));

  beginTurn(TAB, "t1");
  await act(async () => {
    await runSceneTool("update_elements", { tabId: TAB, updates: [{ id: "a", patch: { x: 40 } }] });
    await runSceneTool("add_elements", {
      tabId: TAB,
      elements: [{ type: "ellipse", id: "b", x: 300, y: 0, width: 80, height: 80 }],
    });
  });
  act(() => {
    endTurn(TAB, "t1");
  });
  expect(positions(ex)).toEqual([
    ["a", 40],
    ["b", 300],
  ]);

  undo();
  expect(positions(ex)).toEqual([["a", 0]]);

  // Redo back to the post-turn scene, then revert programmatically.
  act(() => {
    fireEvent.click(document.querySelector<HTMLElement>('[aria-label="Redo"]')!);
  });
  expect(positions(ex)).toEqual([
    ["a", 40],
    ["b", 300],
  ]);
  let result: ReturnType<typeof revertTurn> | undefined;
  act(() => {
    result = revertTurn(TAB, "t1", { force: true });
  });
  expect(result?.ok).toBe(true);
  expect(positions(ex)).toEqual([["a", 0]]);
});

it("select_elements drives the real selection and duplicates become real elements", async () => {
  let api: ExcalidrawImperativeAPI | null = null;
  render(<Excalidraw excalidrawAPI={(a) => (api = a)} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  const ex = api as unknown as ExcalidrawImperativeAPI;
  registerSceneTab(TAB, {
    api: ex,
    title: () => "Real",
    isViewer: () => false,
    markDirty: () => {},
  });
  const seed = convertToExcalidrawElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50, label: { text: "A" } },
      { type: "ellipse", id: "b", x: 300, y: 0, width: 80, height: 80 },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
  act(() => ex.updateScene({ elements: seed, captureUpdate: CaptureUpdateAction.IMMEDIATELY }));

  await act(async () => {
    await runSceneTool("select_elements", { tabId: TAB, ids: ["a", "b"] });
  });
  expect(Object.keys(ex.getAppState().selectedElementIds).sort()).toEqual(["a", "b"]);

  let created: Record<string, string> = {};
  await act(async () => {
    const [res] = await runSceneTool("duplicate_elements", { tabId: TAB, ids: ["a"], dy: 200 });
    created = JSON.parse((res as { text: string }).text).created;
  });
  const copy = ex.getSceneElements().find((e) => e.id === created.a)!;
  expect(copy.y).toBe(200);
  const label = ex.getSceneElements().find((e) => e.type === "text" && e.containerId === copy.id);
  expect(label && "text" in label && label.text).toBe("A");
});

it("add_image registers the file with the real editor and undoes as one step", async () => {
  let api: ExcalidrawImperativeAPI | null = null;
  render(<Excalidraw excalidrawAPI={(a) => (api = a)} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  const ex = api as unknown as ExcalidrawImperativeAPI;
  registerSceneTab(TAB, {
    api: ex,
    title: () => "Real",
    isViewer: () => false,
    markDirty: () => {},
  });
  const seed = convertToExcalidrawElements(
    [
      { type: "rectangle", id: "card", x: 0, y: 0, width: 120, height: 120 },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
  act(() => ex.updateScene({ elements: seed, captureUpdate: CaptureUpdateAction.IMMEDIATELY }));

  const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>');
  let res: { id: string; fileId: string } = { id: "", fileId: "" };
  await act(async () => {
    const [out] = await runSceneTool("add_image", {
      tabId: TAB,
      data: svg,
      mimeType: "image/svg+xml",
      inside: "card",
    });
    res = JSON.parse((out as { text: string }).text);
  });
  const img = ex.getSceneElements().find((e) => e.id === res.id);
  expect(img).toMatchObject({ type: "image", fileId: res.fileId, width: 104, height: 104 });
  expect(ex.getFiles()[res.fileId]?.mimeType).toBe("image/svg+xml");

  undo();
  expect(ex.getSceneElements().map((e) => e.id)).toEqual(["card"]);
});
