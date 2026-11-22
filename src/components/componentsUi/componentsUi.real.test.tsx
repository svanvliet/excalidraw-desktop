// Components UI (FR-55) against the REAL Excalidraw 0.18.1 in jsdom: placing saved components
// (with images), the properties-panel actions, and the library-master Edit / Done / Cancel flow.
import "../../agent/scene/testHarness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { BinaryFileData, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Draft, type El } from "../../agent/scene/draft";
import { createComponent, insertInstance, setOverrides } from "../../extensions/components/actions";
import {
  installComponents,
  runComponentCommand,
  uninstallComponents,
} from "../../extensions/components/host";
import { groupOf, listComponents, tagOf } from "../../extensions/components/model";
import {
  __resetMyComponentsForTest,
  getMyComponents,
  loadMyComponents,
  putMyComponent,
  removeMyComponent,
  type MyComponent,
} from "../../lib/componentLibraryStore";
import { ComponentSection } from "./ComponentSection";
import { componentView } from "./componentPanelSection";
import { placeMyComponent } from "./insert";
import { librarySourceOf, masterToEntry } from "./libraryCodec";
import {
  __clearMasterEdit,
  __setLibraryMasterEngineForTest,
  cancelMasterEdit,
  finishMasterEdit,
  libraryMasterEngine,
  masterEditOf,
} from "./libraryMasters";

type Api = ExcalidrawImperativeAPI;

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

const PHOTO = {
  id: "photo1",
  mimeType: "image/png",
  dataURL: "data:image/png;base64,iVBORw0KGgo=",
  created: 1,
} as BinaryFileData;

/** A saved "Person" card (rectangle, photo, name) with its image file. */
function personEntry(): MyComponent {
  const draft = new Draft(
    convertToExcalidrawElements(
      [
        { type: "rectangle", id: "card", x: 0, y: 0, width: 200, height: 120 },
        { type: "image", id: "pic", x: 10, y: 10, width: 60, height: 60, fileId: "photo1" },
        { type: "text", id: "who", x: 80, y: 30, text: "Ada" },
      ] as ExcalidrawElementSkeleton[],
      { regenerateIds: false },
    ),
  );
  const made = createComponent(draft, ["card", "pic", "who"], "Person");
  return masterToEntry(draft.toArray(), { photo1: PHOTO }, made.componentId);
}

const mounted: Api[] = [];
const installed: Api[] = [];
beforeEach(async () => {
  __resetMyComponentsForTest();
  await loadMyComponents();
});
afterEach(() => {
  for (const api of installed.splice(0)) uninstallComponents(api);
  for (const api of mounted.splice(0)) __clearMasterEdit(api);
  __setLibraryMasterEngineForTest(undefined);
  __resetMyComponentsForTest();
  cleanup();
});

async function mount(elements: El[] = []): Promise<Api> {
  let api: Api | null = null;
  render(<Excalidraw excalidrawAPI={(a) => (api = a)} initialData={{ elements }} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  mounted.push(api!);
  return api as unknown as Api;
}

const live = (api: Api) => api.getSceneElements() as readonly El[];
const undo = () => act(() => void fireEvent.click(document.querySelector('[aria-label="Undo"]')!));
const children = (api: Api, groupId: string) =>
  live(api).filter((e) => {
    const t = tagOf(e);
    return t && groupOf(e, t) === groupId;
  });
const textOf = (els: readonly El[]) =>
  (els.find((e) => e.type === "text") as { text: string } | undefined)?.text;

/** A user edit (one captured history entry). */
function userEdit(api: Api, id: string, patch: Record<string, unknown>) {
  act(() =>
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((e) =>
          e.id === id
            ? { ...e, ...patch, version: e.version + 1, versionNonce: e.versionNonce + 1 }
            : e,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    }),
  );
}

function panel(api: Api, groupId: string) {
  const view = componentView(children(api, groupId), live(api));
  expect(view).not.toBeNull();
  return render(<ComponentSection view={view!} api={api} />);
}

describe("placing a saved component", () => {
  it("adds its image and places master + instance as one undo step (no library masters)", async () => {
    __setLibraryMasterEngineForTest(null);
    const api = await mount();
    installed.push(api);
    installComponents(api, { schedule: () => () => {} });
    const entry = personEntry();
    let res: ReturnType<typeof placeMyComponent> = null;
    act(() => {
      res = placeMyComponent(api, entry, { x: 500, y: 500 });
    });
    expect(res).toMatchObject({ placedMaster: true, componentId: entry.id });
    expect(api.getFiles().photo1?.dataURL).toBe(PHOTO.dataURL);
    const [comp] = listComponents(live(api));
    expect(comp.instances).toHaveLength(1);
    expect(live(api).filter((e) => e.type === "image")).toHaveLength(2);
    undo();
    expect(live(api)).toHaveLength(0);
  });
});

describe("Component panel section", () => {
  async function withOverride() {
    __setLibraryMasterEngineForTest(null);
    const draft = new Draft(personEntry().elements as El[]);
    const id = tagOf(draft.toArray()[0])!.componentId;
    const inst = insertInstance(draft, id, { x: 0, y: 400 });
    const who = draft.toArray().find((e) => inst.ids.includes(e.id) && e.type === "text")!;
    setOverrides(draft, inst.groupId, [{ elementId: who.id, values: { text: "Grace" } }]);
    const api = await mount(draft.toArray());
    return { api, inst };
  }

  it("lists overrides; Reset overrides is one undo step", async () => {
    const { api, inst } = await withOverride();
    panel(api, inst.groupId);
    expect(screen.getByTestId("component-props-summary").textContent).toContain("Person");
    expect(screen.getAllByTestId("component-override")).toHaveLength(1);
    expect(screen.getByTestId("component-override").textContent).toContain('Text "Grace": text');
    act(() => void fireEvent.click(screen.getByTestId("component-reset")));
    expect(
      tagOf(children(api, inst.groupId).find((e) => e.type === "text"))?.overrides,
    ).toBeFalsy();
    undo();
    expect(
      tagOf(children(api, inst.groupId).find((e) => e.type === "text"))?.overrides,
    ).toBeTruthy();
  });

  it("Detach is one undo step", async () => {
    const { api, inst } = await withOverride();
    panel(api, inst.groupId);
    act(() => void fireEvent.click(screen.getByTestId("component-detach")));
    expect(children(api, inst.groupId)).toHaveLength(0);
    undo();
    expect(children(api, inst.groupId)).toHaveLength(3);
  });
});

describe("library-backed masters", () => {
  async function placed() {
    __setLibraryMasterEngineForTest(undefined); // the real engine (host.ts)
    const entry = personEntry();
    await putMyComponent(entry);
    expect(libraryMasterEngine()).not.toBeNull();
    const api = await mount();
    installed.push(api);
    installComponents(api, { schedule: () => () => {} });
    let res: ReturnType<typeof placeMyComponent> = null;
    act(() => {
      res = placeMyComponent(api, entry, { x: 100, y: 100 });
    });
    return { api, entry, inst: res!.instance };
  }

  it("inserts only an instance that links to My components, with its image", async () => {
    const { api, entry, inst } = await placed();
    expect(listComponents(live(api))[0].masterGroupId).toBeNull();
    expect(live(api)).toHaveLength(3);
    for (const e of live(api)) expect(librarySourceOf(e)?.libraryId).toBe(entry.id);
    expect(api.getFiles().photo1).toBeTruthy();
    panel(api, inst.groupId);
    expect(screen.queryByTestId("component-go-to-master")).toBeNull();
    expect(screen.getByTestId("component-edit-master")).toBeTruthy();
  });

  it("Edit master… then Done saves the edit to My components and takes the master away", async () => {
    const { api, entry, inst } = await placed();
    panel(api, inst.groupId);
    act(() => void fireEvent.click(screen.getByTestId("component-edit-master")));
    const edit = masterEditOf(api);
    expect(edit?.componentId).toBe(entry.id);
    const master = children(api, edit!.masterGroupId);
    expect(master).toHaveLength(3);
    userEdit(api, master.find((e) => e.type === "text")!.id, { text: "Grace" });

    await act(async () => void (await finishMasterEdit(api)));
    expect(masterEditOf(api)).toBeNull();
    expect(listComponents(live(api))[0].masterGroupId).toBeNull();
    expect(children(api, edit!.masterGroupId)).toHaveLength(0);
    const saved = getMyComponents().find((c) => c.id === entry.id)!;
    expect(textOf(saved.elements as El[])).toBe("Grace");
    expect(saved.files?.photo1).toBeTruthy();
    expect(children(api, inst.groupId)).toHaveLength(3);
  });

  it("Cancel puts things back as one undo step", async () => {
    const { api, inst } = await placed();
    panel(api, inst.groupId);
    act(() => void fireEvent.click(screen.getByTestId("component-edit-master")));
    const edit = masterEditOf(api)!;
    const rect = children(api, inst.groupId).find((e) => e.type === "rectangle")!;
    userEdit(api, rect.id, { x: rect.x + 50 });
    act(() => void cancelMasterEdit(api));
    expect(masterEditOf(api)).toBeNull();
    expect(children(api, edit.masterGroupId)).toHaveLength(0);
    expect(live(api).find((e) => e.id === rect.id)!.x).toBe(rect.x);
    expect(getMyComponents()[0].updated).toBe(getMyComponents()[0].created);
    // The cancel itself is a single step: one undo brings back the edited state.
    undo();
    expect(children(api, edit.masterGroupId)).toHaveLength(3);
    expect(live(api).find((e) => e.id === rect.id)!.x).toBe(rect.x + 50);
  });

  it("offers Save when this machine doesn't have the definition, with no master placed", async () => {
    const { api, entry, inst } = await placed();
    await act(async () => void (await removeMyComponent(entry.id)));
    panel(api, inst.groupId);
    expect(screen.getByTestId("component-edit-master")).toBeTruthy();
    expect(screen.getByTestId("component-save").textContent).toBe("Save to My components");
    await act(async () => {
      fireEvent.click(screen.getByTestId("component-save"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getMyComponents().map((c) => c.id)).toEqual([entry.id]);
    expect(listComponents(live(api))[0].masterGroupId).toBeNull();
  });

  it("Edit master… → Done on a drawing-only component keeps it out of My components", async () => {
    const { api, entry, inst } = await placed();
    await act(async () => void (await removeMyComponent(entry.id)));
    panel(api, inst.groupId);
    act(() => void fireEvent.click(screen.getByTestId("component-edit-master")));
    const edit = masterEditOf(api)!;
    const text = children(api, edit.masterGroupId).find((e) => e.type === "text")!;
    runComponentCommand(api, () => {}); // a frame: the engine settles before the user edits
    userEdit(api, text.id, { text: "Grace", originalText: "Grace" });
    await act(async () => void (await finishMasterEdit(api)));
    expect(masterEditOf(api)).toBeNull();
    expect(listComponents(live(api))[0].masterGroupId).toBeNull();
    expect(textOf(children(api, inst.groupId))).toBe("Grace");
    expect(getMyComponents()).toHaveLength(0);
  });
});
