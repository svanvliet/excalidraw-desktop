import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryItems } from "@excalidraw/excalidraw/types";
import {
  __resetLibraryStoreForTest,
  libraryHash,
  loadLibrary,
  registerLibrarySink,
  saveLibrary,
} from "./libraryStore";

function item(id: string, version = 1): LibraryItems[number] {
  return {
    id,
    status: "unpublished",
    created: 1,
    elements: [{ id: `${id}-el`, version } as never],
  } as LibraryItems[number];
}

function fakeStore(initial?: unknown) {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set("libraryItems", initial);
  return {
    data,
    get: (async (k: string) => data.get(k)) as <T>(k: string) => Promise<T | undefined>,
    set: vi.fn(async (k: string, v: unknown) => {
      data.set(k, v);
    }),
    save: vi.fn(async () => {}),
  };
}

describe("libraryStore", () => {
  beforeEach(() => __resetLibraryStoreForTest());

  it("loads stored items and drops malformed ones", async () => {
    const store = fakeStore([item("a"), { nope: true }]);
    __resetLibraryStoreForTest(store);
    const items = await loadLibrary();
    expect(items.map((i) => i.id)).toEqual(["a"]);
  });

  it("ignores saves before the library has loaded (never overwrites with the initial empty set)", async () => {
    const store = fakeStore([item("a")]);
    __resetLibraryStoreForTest(store);
    await saveLibrary([]);
    expect(store.set).not.toHaveBeenCalled();
    await loadLibrary();
    expect(store.data.get("libraryItems")).toEqual([item("a")]);
  });

  it("persists changes, skips unchanged ones, and syncs other editors", async () => {
    const store = fakeStore([item("a")]);
    __resetLibraryStoreForTest(store);
    await loadLibrary();
    const source = { updateLibrary: vi.fn(async () => [] as LibraryItems) };
    const other = { updateLibrary: vi.fn(async () => [] as LibraryItems) };
    registerLibrarySink(source);
    const unregister = registerLibrarySink(other);

    await saveLibrary([item("a")], source);
    expect(store.set).not.toHaveBeenCalled();

    const next = [item("a"), item("b")];
    await saveLibrary(next, source);
    expect(store.set).toHaveBeenCalledWith("libraryItems", next);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(source.updateLibrary).not.toHaveBeenCalled();
    expect(other.updateLibrary).toHaveBeenCalledWith({ libraryItems: next, merge: false });

    unregister();
    await saveLibrary([item("b", 2)], source);
    expect(other.updateLibrary).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledTimes(2);
  });

  it("stops saving for the session when the stored library can't be read", async () => {
    const store = fakeStore("garbage");
    __resetLibraryStoreForTest(store);
    expect(await loadLibrary()).toEqual([]);
    await saveLibrary([item("x")]);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("hashes element versions so edited items count as changes", () => {
    expect(libraryHash([item("a", 1)])).not.toEqual(libraryHash([item("a", 2)]));
    expect(libraryHash([item("a"), item("b")])).not.toEqual(libraryHash([item("b"), item("a")]));
  });
});
