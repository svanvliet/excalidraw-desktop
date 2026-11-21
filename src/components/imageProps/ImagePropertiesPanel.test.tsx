import { FakeApi } from "../../agent/scene/testHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { setExtensionsForTests } from "../../extensions/registry";
import { EXT_KEY } from "../../extensions/types";
import { ImagePropertiesPanel, type ImagePanelApi } from "./ImagePropertiesPanel";

vi.mock("../../extensions/raster", () => import("../../extensions/testRaster"));

function image(id: string, type = "image"): ExcalidrawElement {
  return {
    id,
    type,
    x: 100,
    y: 200,
    width: 100,
    height: 100,
    angle: 0,
    seed: 7,
    fileId: `file-${id}`,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    groupIds: [],
    boundElements: null,
    frameId: null,
  } as unknown as ExcalidrawElement;
}

class PanelApi extends FakeApi {
  listeners = new Set<() => void>();
  onChange = ((cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }) as never;
  emit() {
    act(() => this.listeners.forEach((cb) => cb()));
  }
  select(...ids: string[]) {
    this.selectedElementIds = Object.fromEntries(ids.map((id) => [id, true]));
    this.emit();
  }
}

/** Just enough of Excalidraw 0.18.1's DOM: the left properties panel with its first slot. */
function nativePanel(): HTMLElement {
  const column = document.createElement("div");
  column.className = "panelColumn";
  column.innerHTML = `<div data-testid="stroke-slot"></div><fieldset data-testid="edges"></fieldset>`;
  return column;
}

let api: PanelApi;
let wrapper: HTMLDivElement;
let menu: HTMLDivElement;
beforeEach(() => {
  setExtensionsForTests();
  api = new PanelApi([image("i1"), image("i2"), image("r", "rectangle")] as never);
  api.files = {
    "file-i1": { id: "file-i1", mimeType: "image/png", dataURL: "data:i1", created: 1 },
  };
  const realUpdate = api.updateScene as unknown as (d: unknown) => void;
  api.updateScene = ((d: unknown) => {
    realUpdate(d);
    api.emit();
  }) as never;
  wrapper = document.createElement("div");
  wrapper.innerHTML = `<div class="excalidraw excalidraw-container" tabindex="0"><div class="App-menu__left"></div></div>`;
  menu = wrapper.querySelector(".App-menu__left")!;
  document.body.append(wrapper);
});
afterEach(() => {
  setExtensionsForTests();
  wrapper.remove();
});

const renderPanel = () =>
  render(
    <ImagePropertiesPanel api={api as unknown as ImagePanelApi} container={{ current: wrapper }} />,
  );

const chain = (id = "i1") =>
  (api.byId(id)!.customData?.[EXT_KEY] as { chain: { ext: string; params: unknown }[] }).chain;

const pressed = (name: string) =>
  waitFor(() =>
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true"),
  );

describe("ImagePropertiesPanel", () => {
  it("injects its sections right after the native panel's first slot", async () => {
    menu.append(nativePanel());
    renderPanel();
    expect(screen.queryByTestId("image-props-native")).toBeNull();

    api.select("r");
    expect(screen.queryByTestId("image-props-native")).toBeNull();

    api.select("i1");
    const host = await screen.findByTestId("image-props-native");
    expect(host.previousElementSibling).toBe(screen.getByTestId("stroke-slot"));
    expect(within(host).getByText("Stroke")).toBeInTheDocument();
    expect(within(host).getByText("Mask")).toBeInTheDocument();
    // No border yet: the width/style/sloppiness rows wait for one.
    expect(screen.queryByTestId("image-stroke-width")).toBeNull();
    expect(screen.queryByTestId("image-props-dock")).toBeNull();

    api.appState.isResizing = true;
    api.emit();
    await waitFor(() => expect(screen.queryByTestId("image-props-native")).toBeNull());
  });

  it("re-attaches when Excalidraw remounts its panel", async () => {
    menu.append(nativePanel());
    renderPanel();
    api.select("i1");
    await screen.findByTestId("image-props-native");

    menu.replaceChildren(nativePanel());
    await waitFor(() =>
      expect(menu.querySelector(".panelColumn > [data-testid=image-props-native]")).not.toBeNull(),
    );
    expect(screen.getByTestId("image-props-native").previousElementSibling).toBe(
      menu.querySelector("[data-testid=stroke-slot]"),
    );
  });

  it("falls back to a docked island without the native panel, and moves in when it appears", async () => {
    renderPanel();
    api.select("i1");
    const dock = await screen.findByTestId("image-props-dock");
    expect(dock.closest(".Island")).not.toBeNull();
    expect(within(dock).getByRole("button", { name: "Circle" })).toBeInTheDocument();

    act(() => menu.append(nativePanel()));
    await screen.findByTestId("image-props-native");
    expect(screen.queryByTestId("image-props-dock")).toBeNull();
  });

  it("labels the sections as image ones for a mixed selection", async () => {
    menu.append(nativePanel());
    renderPanel();
    api.select("i1", "r");
    const host = await screen.findByTestId("image-props-native");
    expect(within(host).getByText("Image stroke")).toBeInTheDocument();
    expect(within(host).getByText("Image mask")).toBeInTheDocument();
  });

  it("edits the border like a native stroke, one undo step per change", async () => {
    menu.append(nativePanel());
    renderPanel();
    api.select("i1");
    await screen.findByTestId("image-props-native");

    fireEvent.click(screen.getByRole("button", { name: "Stroke #e03131" }));
    await pressed("Stroke #e03131");
    expect(chain()[0]!.params).toEqual({
      width: 2,
      color: "#e03131",
      opacity: 100,
      style: "solid",
      roughness: 0,
    });
    await pressed("Bold");
    await pressed("Solid");
    await pressed("Architect");

    fireEvent.click(screen.getByRole("button", { name: "Extra bold" }));
    await pressed("Extra bold");
    fireEvent.click(screen.getByRole("button", { name: "Dashed" }));
    await pressed("Dashed");
    fireEvent.click(screen.getByRole("button", { name: "Cartoonist" }));
    await pressed("Cartoonist");
    expect(chain()[0]!.params).toEqual({
      width: 4,
      color: "#e03131",
      opacity: 100,
      style: "dashed",
      roughness: 2,
    });
    expect(api.undoStack).toHaveLength(4);
  });

  it("applies and clears a mask", async () => {
    menu.append(nativePanel());
    renderPanel();
    api.select("i1");
    await pressed("No mask");

    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    await pressed("Circle");
    expect(chain().map((l) => l.ext)).toEqual(["mask"]);

    fireEvent.click(screen.getByRole("button", { name: "No mask" }));
    await pressed("No mask");
    expect(api.byId("i1")!.customData?.[EXT_KEY]).toBeUndefined();
  });

  it("shows why nothing changed", async () => {
    menu.append(nativePanel());
    renderPanel();
    api.select("i2"); // its file is not loaded
    fireEvent.click(await screen.findByRole("button", { name: "Circle" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "the image file is not available in this scene",
    );
  });
});

describe("StrokeColorPicker popover", () => {
  async function openPicker() {
    menu.append(nativePanel());
    renderPanel();
    api.select("i1");
    fireEvent.click(await screen.findByRole("button", { name: "Show stroke colour picker" }));
    return screen.findByTestId("image-stroke-popover");
  }

  it("picks palette colours, shades and hex codes", async () => {
    const popover = await openPicker();
    // Mounted inside the editor root so Excalidraw's theme variables apply.
    expect(wrapper.querySelector(".excalidraw [data-testid=image-stroke-popover]")).toBe(popover);
    expect(within(popover).getByText("No shades available for this color")).toBeInTheDocument();

    fireEvent.click(within(popover).getByRole("button", { name: "blue" }));
    await waitFor(() => expect(chain()[0]!.params).toMatchObject({ color: "#1971c2" }));

    fireEvent.click(within(popover).getByRole("button", { name: "Shade 1" }));
    await waitFor(() => expect(chain()[0]!.params).toMatchObject({ color: "#e7f5ff" }));

    const hex = within(popover).getByRole("textbox", { name: "Stroke hex code" });
    expect(hex).toHaveValue("e7f5ff");
    fireEvent.change(hex, { target: { value: "abc" } });
    expect(chain()[0]!.params).toMatchObject({ color: "#e7f5ff" }); // short codes wait for Enter
    fireEvent.keyDown(hex, { key: "Enter" });
    await waitFor(() => expect(chain()[0]!.params).toMatchObject({ color: "#aabbcc" }));
    fireEvent.change(hex, { target: { value: "2f9e44" } });
    await waitFor(() => expect(chain()[0]!.params).toMatchObject({ color: "#2f9e44" }));
    expect(api.undoStack).toHaveLength(4);
  });

  it("supports Excalidraw's hotkeys without leaking them to the editor, and Escape closes", async () => {
    const onDocKey = vi.fn();
    document.addEventListener("keydown", onDocKey);
    try {
      const popover = await openPicker();
      fireEvent.keyDown(popover.querySelector(".color-picker-content")!, { key: "b" }); // red: the last palette colour
      await waitFor(() => expect(chain()[0]!.params).toMatchObject({ color: "#e03131" }));
      expect(onDocKey).not.toHaveBeenCalled();

      fireEvent.keyDown(popover.querySelector(".color-picker-content")!, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("image-stroke-popover")).toBeNull());
      expect(document.activeElement).toBe(wrapper.querySelector(".excalidraw-container"));
    } finally {
      document.removeEventListener("keydown", onDocKey);
    }
  });

  it("transparent removes the border", async () => {
    const popover = await openPicker();
    fireEvent.click(within(popover).getByRole("button", { name: "red" }));
    await waitFor(() => expect(chain()).toHaveLength(1));
    fireEvent.click(within(popover).getByRole("button", { name: "transparent" }));
    await waitFor(() => expect(api.byId("i1")!.customData?.[EXT_KEY]).toBeUndefined());
    expect(screen.queryByTestId("image-stroke-width")).toBeNull();
  });
});
