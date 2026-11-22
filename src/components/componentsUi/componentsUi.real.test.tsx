// Components UI (FR-55) against the REAL Excalidraw 0.18.1 in jsdom: placing saved components
// (with images), the properties-panel actions, and the master-edit overlay's Done / Cancel (FR-66).
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
import {
  createComponent,
  defineProperty,
  insertInstance,
  setOverrides,
} from "../../extensions/components/actions";
import {
  createComponentFromSelection,
  defineComponentProperty,
  insertComponentInstance,
  installComponents,
  setInstanceProperties,
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
import { __setLibraryMasterEngineForTest, libraryMasterEngine } from "./libraryMasters";
import { MasterEditorHost } from "./MasterEditor";
import { CTX_KEY } from "./masterEditScene";
import { useMasterEditStore } from "./masterEditStore";

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
  localStorage.setItem("excalidraw-desktop:e2e", "1");
  __resetMyComponentsForTest();
  await loadMyComponents();
});
afterEach(() => {
  for (const api of installed.splice(0)) uninstallComponents(api);
  mounted.splice(0);
  useMasterEditStore.getState().close();
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

  it("lists overrides; Reset overrides resets the look in one undo step and keeps content (FR-67)", async () => {
    const { api, inst } = await withOverride();
    const card = children(api, inst.groupId).find((e) => e.type === "rectangle")!;
    const draft = new Draft(live(api));
    setOverrides(draft, inst.groupId, [
      { elementId: card.id, values: { backgroundColor: "#ffc9c9" } },
    ]);
    act(() =>
      api.updateScene({ elements: draft.toArray(), captureUpdate: CaptureUpdateAction.NEVER }),
    );
    panel(api, inst.groupId);
    expect(screen.getByTestId("component-props-summary").textContent).toContain("Person");
    const rows = screen.getAllByTestId("component-override").map((r) => r.textContent);
    expect(rows).toEqual(expect.arrayContaining(['Text "Grace": text', "Rectangle: fill"]));
    act(() => void fireEvent.click(screen.getByTestId("component-reset")));
    const after = children(api, inst.groupId);
    expect(
      tagOf(after.find((e) => e.type === "rectangle"))?.overrides?.backgroundColor,
    ).toBeUndefined();
    expect(textOf(after)).toBe("Grace");
    expect(tagOf(after.find((e) => e.type === "text"))?.overrides?.text).toBe("Grace");
    undo();
    expect(
      tagOf(children(api, inst.groupId).find((e) => e.type === "rectangle"))?.overrides
        ?.backgroundColor,
    ).toBe("#ffc9c9");
  });

  it("content-only overrides leave Reset overrides disabled; the slot × still clears them", async () => {
    const { api, inst } = await withOverride();
    panel(api, inst.groupId);
    expect((screen.getByTestId("component-reset") as HTMLButtonElement).disabled).toBe(true);
    act(() => void fireEvent.click(screen.getByLabelText('Reset Text "Grace"')));
    expect(
      tagOf(children(api, inst.groupId).find((e) => e.type === "text"))?.overrides,
    ).toBeFalsy();
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
    expect(screen.getByTestId("component-edit-master")).toBeTruthy();
  });

  /** Edit master… from the panel; returns the overlay's API. */
  async function openOverlay(api: Api, instanceGroupId: string) {
    panel(api, instanceGroupId);
    act(() => void fireEvent.click(screen.getByTestId("component-edit-master")));
    render(<MasterEditorHost api={api} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId("master-edit-header").textContent).toContain("Person");
    return window.__masterEditor as unknown as Api;
  }
  const masterIn = (overlay: Api) => live(overlay).filter((e) => !e.customData?.[CTX_KEY]);
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

  it("opens the master over the instance; the drawing gets no master", async () => {
    const { api, inst } = await placed();
    const overlay = await openOverlay(api, inst.groupId);
    const master = masterIn(overlay);
    expect(master).toHaveLength(3);
    expect(master.every((e) => tagOf(e)?.role === "master")).toBe(true);
    const rect = (els: readonly El[]) => els.find((e) => e.type === "rectangle")!;
    expect([rect(master).x, rect(master).y]).toEqual([
      rect(children(api, inst.groupId)).x,
      rect(children(api, inst.groupId)).y,
    ]);
    expect(listComponents(live(api))[0].masterGroupId).toBeNull();
    expect(live(api)).toHaveLength(3);
  });

  it("Done applies the edit to the drawing in one undo step and updates My components", async () => {
    const { api, entry, inst } = await placed();
    const overlay = await openOverlay(api, inst.groupId);
    const text = masterIn(overlay).find((e) => e.type === "text")!;
    userEdit(overlay, text.id, { text: "Grace", originalText: "Grace" });
    expect(screen.getByTestId("master-edit-update-library")).toBeTruthy();
    act(() => void fireEvent.click(screen.getByTestId("master-edit-done")));
    await flush();
    expect(useMasterEditStore.getState().session).toBeNull();
    expect(screen.queryByTestId("master-edit")).toBeNull();
    expect(textOf(children(api, inst.groupId))).toBe("Grace");
    expect(listComponents(live(api))[0].masterGroupId).toBeNull();
    const saved = getMyComponents().find((c) => c.id === entry.id)!;
    expect(textOf(saved.elements as El[])).toBe("Grace");
    expect(saved.files?.photo1).toBeTruthy();
    undo();
    expect(textOf(children(api, inst.groupId))).toBe("Ada");
  });

  it("Cancel leaves the drawing and My components alone", async () => {
    const { api, inst } = await placed();
    const before = live(api).map((e) => `${e.id}:${e.version}`);
    const overlay = await openOverlay(api, inst.groupId);
    const rect = masterIn(overlay).find((e) => e.type === "rectangle")!;
    userEdit(overlay, rect.id, { x: rect.x + 50 });
    act(() => void fireEvent.click(screen.getByTestId("master-edit-cancel")));
    expect(useMasterEditStore.getState().session).toBeNull();
    expect(live(api).map((e) => `${e.id}:${e.version}`)).toEqual(before);
    expect(getMyComponents()[0].updated).toBe(getMyComponents()[0].created);
  });

  it("offers Save when this machine doesn't have the definition, with no master placed", async () => {
    const { api, entry, inst } = await placed();
    await act(async () => void (await removeMyComponent(entry.id)));
    panel(api, inst.groupId);
    expect(screen.getByTestId("component-edit-master")).toBeTruthy();
    expect(screen.getByTestId("component-save").textContent).toBe("Save to My components");
    // Still tagged library-backed, but not in My components: don't claim it comes from there.
    expect(screen.getByTestId("component-props-summary").textContent).not.toContain(
      "from My components",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("component-save"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getMyComponents().map((c) => c.id)).toEqual([entry.id]);
    expect(screen.getByTestId("component-save").textContent).toBe("Update in My components");
    expect(screen.getByTestId("component-props-summary").textContent).toContain(
      "from My components",
    );
    expect(listComponents(live(api))[0].masterGroupId).toBeNull();
  });

  it("Done on a drawing-only component keeps it out of My components", async () => {
    const { api, entry, inst } = await placed();
    await act(async () => void (await removeMyComponent(entry.id)));
    const overlay = await openOverlay(api, inst.groupId);
    expect(screen.queryByTestId("master-edit-update-library")).toBeNull();
    const text = masterIn(overlay).find((e) => e.type === "text")!;
    userEdit(overlay, text.id, { text: "Grace", originalText: "Grace" });
    act(() => void fireEvent.click(screen.getByTestId("master-edit-done")));
    await flush();
    expect(textOf(children(api, inst.groupId))).toBe("Grace");
    expect(getMyComponents()).toHaveLength(0);
  });
});

describe("slots hidden by a property (FR-69)", () => {
  /** A masterless Card (rectangle R + ellipse E) whose Avatar choice shows R for photo and E for
   * initials, with two instances both on photo: E is hidden in every instance. */
  async function avatarCards() {
    __setLibraryMasterEngineForTest(undefined);
    const api = await mount(
      convertToExcalidrawElements(
        [
          { type: "rectangle", id: "R", x: 0, y: 0, width: 200, height: 80, label: { text: "Hi" } },
          { type: "ellipse", id: "E", x: 220, y: 20, width: 40, height: 40 },
        ] as ExcalidrawElementSkeleton[],
        { regenerateIds: false },
      ),
    );
    installed.push(api);
    installComponents(api, { schedule: () => () => {} });
    act(() => api.updateScene({ appState: { selectedElementIds: { R: true, E: true } } as never }));
    let first: ReturnType<typeof createComponentFromSelection> = null;
    act(() => void (first = createComponentFromSelection(api, "Card")));
    const cid = first!.componentId;
    let second: ReturnType<typeof insertComponentInstance> = null;
    act(() => {
      second = insertComponentInstance(api, cid, { x: 0, y: 300 });
      defineComponentProperty(api, cid, {
        id: "avatar",
        name: "Avatar",
        type: "choice",
        options: ["photo", "initials"],
        default: "photo",
        bindings: [
          { elementId: "R", key: "visible", map: { photo: true, initials: false } },
          { elementId: "E", key: "visible", map: { photo: false, initials: true } },
        ],
      });
    });
    const groups = [first!.groupId, second!.groupId];
    for (const g0 of groups) expect(slots(api, g0)).toEqual(["R"]);
    return { api, cid, groups };
  }
  const slots = (api: Api, groupId: string) =>
    children(api, groupId)
      .filter((e) => e.type !== "text")
      .map((e) => tagOf(e)!.slot)
      .sort();
  const toInitials = (api: Api, groupId: string) =>
    act(() => void setInstanceProperties(api, groupId, { Avatar: "initials" }));

  it("Done from an instance that hides a slot keeps it in the master", async () => {
    const { api, groups } = await avatarCards();
    panel(api, groups[0]);
    act(() => void fireEvent.click(screen.getByTestId("component-edit-master")));
    render(<MasterEditorHost api={api} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    const overlay = window.__masterEditor as unknown as Api;
    const master = live(overlay).filter((e) => !e.customData?.[CTX_KEY]);
    expect(master.map((e) => e.type).sort()).toEqual(["ellipse", "rectangle", "text"]);
    const text = master.find((e) => e.type === "text")!;
    userEdit(overlay, text.id, { text: "Bye", originalText: "Bye" });
    act(() => void fireEvent.click(screen.getByTestId("master-edit-done")));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(textOf(children(api, groups[1]))).toBe("Bye");
    toInitials(api, groups[1]);
    expect(slots(api, groups[1])).toEqual(["E"]);
  });

  it("Save to My components from such an instance keeps the hidden slot", async () => {
    const { api, cid, groups } = await avatarCards();
    panel(api, groups[0]);
    await act(async () => {
      fireEvent.click(screen.getByTestId("component-save"));
      await new Promise((r) => setTimeout(r, 0));
    });
    const saved = getMyComponents().find((c) => c.id === cid)!;
    expect(saved.elements.map((e) => e.type).sort()).toEqual(["ellipse", "rectangle", "text"]);
    toInitials(api, groups[0]);
    expect(slots(api, groups[0])).toEqual(["E"]);
  });
});

describe("a master left on the canvas by an older build", () => {
  /** A legacy drawing (as Excalidraw's own Open, a paste or a library item brings it in, without
   * load-time demotion): Card master on the canvas plus one instance; its Avatar choice hides E. */
  async function legacy() {
    __setLibraryMasterEngineForTest(undefined);
    const draft = new Draft(
      convertToExcalidrawElements(
        [
          { type: "rectangle", id: "R", x: 0, y: 0, width: 200, height: 80 },
          { type: "ellipse", id: "E", x: 220, y: 20, width: 40, height: 40 },
          { type: "text", id: "T", x: 10, y: 10, text: "Hi" },
        ] as ExcalidrawElementSkeleton[],
        { regenerateIds: false },
      ),
    );
    const made = createComponent(draft, ["R", "E", "T"], "Card");
    defineProperty(draft, made.componentId, {
      name: "Avatar",
      type: "choice",
      options: ["photo", "initials"],
      default: "photo",
      bindings: [{ elementId: "E", key: "visible", map: { photo: false, initials: true } }],
    });
    const inst = insertInstance(draft, made.componentId, { x: 0, y: 300 });
    const api = await mount(draft.toArray());
    installed.push(api);
    installComponents(api, { schedule: () => () => {} });
    expect(listComponents(live(api))[0].masterGroupId).toBe(made.masterGroupId);
    return { api, master: made.masterGroupId, inst: inst.groupId };
  }

  it("Edit master… on it moves it off the canvas and opens the master editor", async () => {
    const { api, master, inst } = await legacy();
    panel(api, master);
    act(() => void fireEvent.click(screen.getByTestId("component-edit-master")));
    render(<MasterEditorHost api={api} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(listComponents(live(api))[0].masterGroupId).toBeNull();
    const overlay = window.__masterEditor as unknown as Api;
    const edited = live(overlay).filter((e) => !e.customData?.[CTX_KEY]);
    expect(edited.map((e) => e.type).sort()).toEqual(["ellipse", "rectangle", "text"]);
    userEdit(overlay, edited.find((e) => e.type === "text")!.id, {
      text: "Bye",
      originalText: "Bye",
    });
    act(() => void fireEvent.click(screen.getByTestId("master-edit-done")));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    for (const g0 of [master, inst]) {
      expect(textOf(children(api, g0))).toBe("Bye");
      act(() => void setInstanceProperties(api, g0, { Avatar: "initials" }));
      expect(children(api, g0).some((e) => e.type === "ellipse")).toBe(true);
    }
  });
});
