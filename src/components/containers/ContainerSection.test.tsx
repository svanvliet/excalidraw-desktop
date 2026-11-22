import { FakeApi } from "../../agent/scene/testHarness";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { Draft } from "../../agent/scene/draft";
import { isMakeContainerShortcut } from "../../layout/containers/host";
import { extractGraph, layoutTargets } from "../../layout/graph";
import type { PanelApi } from "../propertiesPanel/panel";
import { containerPanelSection } from "./containerPanelSection";

const Section = containerPanelSection.Component!;
afterEach(cleanup);

function setup() {
  const api = new FakeApi(
    convertToExcalidrawElements(
      [
        { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 40 },
        { type: "rectangle", id: "b", x: 0, y: 100, width: 60, height: 60 },
        { type: "rectangle", id: "c", x: 300, y: 0, width: 50, height: 50 },
      ] as unknown as ExcalidrawElementSkeleton[],
      { regenerateIds: false },
    ),
  );
  const select = (ids: string[]) => {
    api.selectedElementIds = Object.fromEntries(ids.map((id) => [id, true as const]));
  };
  const viewOf = (ids: string[]) =>
    containerPanelSection.view({
      api: api as unknown as PanelApi,
      appState: api.getAppState(),
      selected: api.elements.filter(
        (e) => ids.includes(e.id) && !e.isDeleted,
      ) as ExcalidrawElement[],
    });
  const show = (ids: string[]) =>
    render(<Section view={viewOf(ids)!} api={api as unknown as PanelApi} />);
  const el = (id: string) => api.elements.find((e) => e.id === id)!;
  return { api, select, viewOf, show, el };
}

function made() {
  const s = setup();
  s.select(["a", "b"]);
  s.show(["a", "b"]);
  fireEvent.click(screen.getByTestId("container-make"));
  cleanup();
  const box = s.api.elements.find((e) => e.customData?.["excalidrawDesktop.layout"])!;
  const group = box.groupIds[0];
  const members = s.api.elements.filter((e) => e.groupIds.includes(group)).map((e) => e.id);
  return { ...s, box, group, members };
}

describe("Container section", () => {
  it("offers make for a multi-selection only", () => {
    const { viewOf } = setup();
    expect(viewOf(["a"])).toBeNull();
    expect(viewOf(["a", "b"])).toMatchObject({ mode: "make" });
  });

  it("makes a container in one undo step and selects it", () => {
    const { api, box, group, members, el } = made();
    expect(api.undoStack).toHaveLength(1);
    expect(members).toHaveLength(3);
    expect(api.appState.selectedGroupIds).toEqual({ [group]: true });
    expect(el("b").y).toBe(56); // a (40) + gap 16, padding 16 from the box
    expect(box).toMatchObject({ x: -16, y: -16 });
  });

  it("edits settings of a selected container", () => {
    const { api, members, show, box, el } = made();
    show(members);
    const gap = screen.getByTestId("container-gap") as HTMLInputElement;
    fireEvent.change(gap, { target: { value: "4" } });
    fireEvent.blur(gap);
    expect(el("b").y).toBe(44);
    fireEvent.click(screen.getByRole("button", { name: "Horizontal stack" }));
    expect(el("b")).toMatchObject({ x: 104, y: 0 });
    expect(api.undoStack).toHaveLength(3);
    // Distribute only shows when the main axis is fixed.
    expect(screen.queryByTestId("container-justify")).toBeNull();
    fireEvent.click(screen.getByTestId("container-remove"));
    expect(api.elements.find((e) => e.id === box.id)?.isDeleted ?? true).toBe(true);
    expect(el("a").groupIds).toEqual([]);
  });

  it("reorders and takes out the child selected inside a container", () => {
    const { viewOf, show, el, box } = made();
    expect(viewOf(["b"])).toMatchObject({ mode: "child", index: 1, count: 2 });
    show(["b"]);
    fireEvent.click(screen.getByTestId("container-child-earlier"));
    expect(el("b").y).toBe(0);
    expect(el("a").y).toBe(76);
    cleanup();
    show(["b"]);
    fireEvent.click(screen.getByTestId("container-child-remove"));
    expect(el("b").groupIds).toEqual([]);
    expect(el(box.id).height).toBe(16 + 40 + 16);
  });
});

describe("integration points", () => {
  it("Alt/Option+Shift+A is the make-container shortcut", () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(isMakeContainerShortcut(ev({ code: "KeyA", altKey: true, shiftKey: true }))).toBe(true);
    expect(isMakeContainerShortcut(ev({ code: "KeyA", altKey: true }))).toBe(false);
    expect(
      isMakeContainerShortcut(ev({ code: "KeyA", altKey: true, shiftKey: true, metaKey: true })),
    ).toBe(false);
  });

  it("auto-layout treats a container as one node", () => {
    const { api, box, members } = made();
    const d = new Draft(api.elements as ExcalidrawElement[]);
    const graph = extractGraph(d, layoutTargets(d));
    const node = graph.nodes.find((n) => n.members.includes(box.id))!;
    expect(node.members.sort()).toEqual([...members].sort());
    expect(graph.nodes).toHaveLength(2);
  });
});
