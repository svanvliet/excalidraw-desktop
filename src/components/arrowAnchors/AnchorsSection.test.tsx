import { FakeApi } from "../../agent/scene/testHarness";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type {
  ExcalidrawElbowArrowElement,
  ExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { PanelApi } from "../propertiesPanel/panel";
import { anchorsPanelSection, type AnchorsView } from "./anchorsPanelSection";

const AnchorsSection = anchorsPanelSection.Component;
afterEach(cleanup);

function setup(arrow: Record<string, unknown>) {
  const api = new FakeApi(
    convertToExcalidrawElements(
      [
        { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50 },
        { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 50 },
        { type: "arrow", id: "x", x: 100, y: 25, start: { id: "a" }, end: { id: "b" }, ...arrow },
      ] as unknown as ExcalidrawElementSkeleton[],
      { regenerateIds: false },
    ),
  );
  const viewOf = (ids = ["x"]) =>
    anchorsPanelSection.view({
      api: api as unknown as PanelApi,
      appState: api.getAppState(),
      selected: api.elements.filter((e) => ids.includes(e.id)) as ExcalidrawElement[],
    });
  return { api, viewOf };
}

describe("AnchorsSection", () => {
  it("only shows for a single bound elbow arrow", () => {
    expect(setup({ elbowed: true }).viewOf()).toMatchObject({ id: "x", start: { bound: true } });
    expect(setup({ elbowed: true }).viewOf(["x", "a"])).toBeNull();
    expect(setup({}).viewOf()).toBeNull();
    expect(setup({ elbowed: true, start: undefined, end: undefined }).viewOf()).toBeNull();
  });

  it("pins an end with one undo step and shows the active side", () => {
    const { api, viewOf } = setup({ elbowed: true });
    const ui = render(
      <AnchorsSection view={viewOf() as AnchorsView} api={api as unknown as PanelApi} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start: Top" }));
    const arrow = api.elements.find((e) => e.id === "x") as ExcalidrawElbowArrowElement;
    expect(arrow.startBinding?.fixedPoint).toEqual([0.5001, -0.1]);
    expect(api.undoStack).toHaveLength(1);
    ui.rerender(<AnchorsSection view={viewOf() as AnchorsView} api={api as unknown as PanelApi} />);
    expect(screen.getByRole("button", { name: "Start: Top" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "End: Side facing the other end" }));
    const next = api.elements.find((e) => e.id === "x") as ExcalidrawElbowArrowElement;
    expect(next.endBinding?.fixedPoint).toEqual([-0.05, 0.5001]);
    expect(api.undoStack).toHaveLength(2);
  });
});
