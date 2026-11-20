import { FakeApi } from "../agent/scene/testHarness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { setExtensionsForTests } from "../extensions/registry";
import { stubExtension } from "../extensions/testStub";
import { extensionGroups } from "../extensions/groups";
import { ExtensionsBar, type ExtensionsBarApi } from "./ExtensionsBar";

function image(id: string, type = "image"): ExcalidrawElement {
  return {
    id,
    type,
    x: 100,
    y: 200,
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
  } as unknown as ExcalidrawElement;
}

class BarApi extends FakeApi {
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

let api: BarApi;
beforeEach(() => {
  setExtensionsForTests([stubExtension]);
  api = new BarApi([image("i1"), image("i2"), image("r", "rectangle")] as never);
  api.files = {
    "file-i1": { id: "file-i1", mimeType: "image/png", dataURL: "data:i1", created: 1 },
  };
  const realUpdate = api.updateScene as unknown as (d: unknown) => void;
  api.updateScene = ((d: unknown) => {
    realUpdate(d);
    api.emit();
  }) as never;
});
afterEach(() => setExtensionsForTests());

const renderBar = () => render(<ExtensionsBar api={api as unknown as ExtensionsBarApi} />);

describe("ExtensionsBar", () => {
  it("only shows for a selection an extension applies to", () => {
    renderBar();
    expect(screen.queryByRole("toolbar")).toBeNull();
    api.select("r");
    expect(screen.queryByRole("toolbar")).toBeNull();
    api.select("i1", "r");
    expect(screen.getByRole("toolbar", { name: "Extensions" })).toHaveStyle({
      left: "150px",
      top: "188px",
    });
    api.appState.isResizing = true;
    api.select("i1");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("applies a preset as one undo step, marks it active, and removes it", async () => {
    renderBar();
    api.select("i1");
    expect(screen.queryByRole("button", { name: "Remove stub" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(api.undoStack).toHaveLength(1);
    expect(api.addFiles).toHaveBeenCalledWith([expect.objectContaining({ id: "file-i1-red" })]);

    fireEvent.click(screen.getByRole("button", { name: "Remove stub" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove stub" })).toBeNull());
    expect((api.byId("i1") as unknown as { fileId: string }).fileId).toBe("file-i1");
  });

  it("shows why nothing changed", async () => {
    renderBar();
    api.select("i2"); // its file is not loaded, so the stub throws
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("missing file file-i2");
  });

  it("groups presets with mixed state", () => {
    const applied = {
      ...image("a"),
      fileId: "file-a-red",
      customData: {
        excalidrawDesktop: {
          ext: "stub",
          v: 1,
          params: { color: "red" },
          source: { fileId: "file-a" },
          outputFileId: "file-a-red",
        },
      },
    } as unknown as ExcalidrawElement;
    const [g] = extensionGroups([applied, image("b")]);
    expect(g).toMatchObject({ id: "stub", ids: ["a", "b"], removable: true });
    expect(g!.presets.map((p) => p.active)).toEqual([false, false]);
    expect(extensionGroups([applied])[0]!.presets.map((p) => p.active)).toEqual([true, false]);
  });
});
