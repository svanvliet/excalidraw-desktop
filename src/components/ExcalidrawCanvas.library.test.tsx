// Real-Excalidraw check that the personal library survives "restarts": the canvas seeds the
// stored library, an import is saved, and guest canvases never write (FR-49).
import "../agent/scene/testHarness";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ExcalidrawImperativeAPI, LibraryItems } from "@excalidraw/excalidraw/types";
import { ExcalidrawCanvas } from "./ExcalidrawCanvas";
import { __resetLibraryStoreForTest } from "../lib/libraryStore";

const g = globalThis as Record<string, unknown>;
g.Path2D ??= class {
  addPath() {}
};
g.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const fonts = (document as unknown as { fonts: Record<string, unknown> }).fonts;
fonts.has ??= () => true;
fonts.addEventListener ??= () => {};
fonts.removeEventListener ??= () => {};

function item(id: string): LibraryItems[number] {
  return {
    id,
    status: "unpublished",
    created: 1,
    elements: [
      {
        id: `${id}-rect`,
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        groupIds: [],
        boundElements: null,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        angle: 0,
        seed: 1,
        roundness: null,
        frameId: null,
        link: null,
        locked: false,
        updated: 1,
        index: "a0",
      } as never,
    ],
  } as LibraryItems[number];
}

function fakeStore(initial: unknown) {
  const data = new Map<string, unknown>([["libraryItems", initial]]);
  return {
    data,
    get: (async (k: string) => data.get(k)) as <T>(k: string) => Promise<T | undefined>,
    set: vi.fn(async (k: string, v: unknown) => {
      data.set(k, v);
    }),
    save: vi.fn(async () => {}),
  };
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

async function mount(persistLibrary: boolean) {
  let api: ExcalidrawImperativeAPI | null = null;
  render(
    <ExcalidrawCanvas
      onApi={(a) => (api = a)}
      onSceneChange={() => {}}
      persistLibrary={persistLibrary}
    />,
  );
  await settle();
  await settle();
  return api as unknown as ExcalidrawImperativeAPI;
}

const ids = (items: readonly { id: string }[]) => items.map((i) => i.id).sort();

beforeEach(() => __resetLibraryStoreForTest());
afterEach(() => cleanup());

it("seeds the stored library and persists an imported item", async () => {
  const store = fakeStore([item("stored")]);
  __resetLibraryStoreForTest(store);
  const api = await mount(true);
  expect(ids(await api.updateLibrary({ libraryItems: [], merge: true }))).toEqual(["stored"]);
  expect(store.set).not.toHaveBeenCalled();

  await act(async () => {
    await api.updateLibrary({ libraryItems: [item("imported")], merge: true });
  });
  await settle();
  expect(store.set).toHaveBeenCalled();
  expect(ids(store.data.get("libraryItems") as LibraryItems)).toEqual(["imported", "stored"]);
});

it("never writes the library from a guest canvas", async () => {
  const store = fakeStore([item("stored")]);
  __resetLibraryStoreForTest(store);
  const api = await mount(false);
  expect(ids(await api.updateLibrary({ libraryItems: [], merge: true }))).toEqual(["stored"]);
  await act(async () => {
    await api.updateLibrary({ libraryItems: [item("guest")], merge: true });
  });
  await settle();
  expect(store.set).not.toHaveBeenCalled();
});
