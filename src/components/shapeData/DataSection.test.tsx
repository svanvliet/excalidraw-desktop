import { FakeApi } from "../../agent/scene/testHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { DATA_KEY, readData } from "../../lib/shapeData";
import type { PanelApi } from "../propertiesPanel/panel";
import { dataPanelSection, type DataView } from "./dataPanelSection";

const DataSection = dataPanelSection.Component;

let api: FakeApi;
beforeEach(() => {
  api = new FakeApi(
    convertToExcalidrawElements(
      [
        {
          type: "rectangle",
          id: "a",
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          label: { text: "Alpha" },
        },
        { type: "ellipse", id: "b", x: 300, y: 0, width: 100, height: 60 },
      ] as unknown as ExcalidrawElementSkeleton[],
      { regenerateIds: false },
    ),
  );
});
afterEach(cleanup);

const byId = (id: string) => api.elements.find((e) => e.id === id) as ExcalidrawElement;
const dataOf = (id: string) => readData(byId(id)).entries;

/** Renders the section for `ids` and re-renders after every scene write, like the host does. */
function renderFor(...ids: string[]) {
  const viewOf = () =>
    dataPanelSection.view({
      api: api as unknown as PanelApi,
      appState: api.getAppState(),
      selected: api.elements.filter((e) => ids.includes(e.id)) as ExcalidrawElement[],
    }) as DataView;
  const ui = render(<DataSection view={viewOf()} api={api as unknown as PanelApi} />);
  const update = api.updateScene as unknown as (data: unknown) => void;
  api.updateScene = ((data: unknown) => {
    update(data);
    ui.rerender(<DataSection view={viewOf()} api={api as unknown as PanelApi} />);
  }) as never;
  return ui;
}

const addRow = (key: string, value: string) => {
  fireEvent.change(screen.getByLabelText("New key"), { target: { value: key } });
  fireEvent.change(screen.getByLabelText("New value"), { target: { value: value } });
  fireEvent.keyDown(screen.getByLabelText("New value"), { key: "Enter" });
};

describe("Data section", () => {
  it("adds, edits, renames and removes rows, one undo step each", () => {
    renderFor("a");
    addRow("owner", "ann");
    addRow("cost", "3");
    expect(dataOf("a")).toEqual([
      ["owner", "ann"],
      ["cost", "3"],
    ]);
    expect(screen.getByLabelText("New key")).toHaveValue("");

    const value = screen.getByLabelText("Value of owner");
    fireEvent.change(value, { target: { value: "bob" } });
    fireEvent.blur(value);
    const key = screen.getByLabelText("Key cost");
    fireEvent.change(key, { target: { value: " price " } });
    fireEvent.keyDown(key, { key: "Enter" });
    fireEvent.blur(key);
    expect(dataOf("a")).toEqual([
      ["owner", "bob"],
      ["price", "3"],
    ]);

    fireEvent.click(screen.getByLabelText("Remove owner"));
    expect(dataOf("a")).toEqual([["price", "3"]]);
    expect(api.undoStack).toHaveLength(5);
    expect(api.calls.every((c) => c.captureUpdate === "IMMEDIATELY")).toBe(true);

    api.undo();
    expect(dataOf("a")).toEqual([
      ["owner", "bob"],
      ["price", "3"],
    ]);
  });

  it("puts data on the container, not its selected label", () => {
    const label = api.elements.find((e) => e.type === "text")!;
    renderFor("a", label.id);
    expect(screen.getByRole("group")).toHaveTextContent("Data");
    addRow("k", "v");
    expect(dataOf("a")).toEqual([["k", "v"]]);
    expect(readData(label as ExcalidrawElement).entries).toEqual([]);
  });

  it("shows shared keys of a mixed selection and edits them all", () => {
    api.elements = api.elements.map((e) =>
      e.id === "a"
        ? ({
            ...e,
            customData: {
              [DATA_KEY]: {
                v: 1,
                entries: [
                  ["k", "1"],
                  ["x", "y"],
                ],
              },
            },
          } as never)
        : e.id === "b"
          ? ({ ...e, customData: { [DATA_KEY]: { v: 1, entries: [["k", "2"]] } } } as never)
          : e,
    );
    renderFor("a", "b");
    expect(screen.getByText("Data (2 elements)")).toBeInTheDocument();
    expect(screen.getAllByTestId("shape-data-row")).toHaveLength(1);
    expect(screen.getByText("+1 key not shared")).toBeInTheDocument();
    const value = screen.getByLabelText("Value of k");
    expect(value).toHaveAttribute("placeholder", "Mixed");
    fireEvent.blur(value);
    expect(api.undoStack).toHaveLength(0);

    fireEvent.change(value, { target: { value: "3" } });
    fireEvent.blur(value);
    expect(dataOf("a")).toEqual([
      ["k", "3"],
      ["x", "y"],
    ]);
    expect(dataOf("b")).toEqual([["k", "3"]]);
    expect(api.undoStack).toHaveLength(1);
  });

  it("is read-only for data from a newer version", () => {
    api.elements = api.elements.map((e) =>
      e.id === "a"
        ? ({ ...e, customData: { [DATA_KEY]: { v: 9, entries: [["k", "1"]] } } } as never)
        : e,
    );
    renderFor("a");
    expect(screen.getByLabelText("Key k")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Remove k")).toBeDisabled();
    expect(screen.queryByLabelText("New key")).toBeNull();
  });

  it("copies the selection's data as CSV", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderFor("a", "b");
    addRow("owner", "ann");
    fireEvent.click(screen.getByTestId("shape-data-copy"));
    await screen.findByText("Copied");
    expect(writeText).toHaveBeenCalledWith(
      "id,type,label,owner\r\na,rectangle,Alpha,ann\r\nb,ellipse,,ann\r\n",
    );
  });
});
