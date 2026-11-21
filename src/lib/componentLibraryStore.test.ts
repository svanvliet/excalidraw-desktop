import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMyComponentsForTest,
  canSaveMyComponents,
  getMyComponents,
  loadMyComponents,
  putMyComponent,
  removeMyComponent,
  renameMyComponent,
  subscribeMyComponents,
  type MyComponent,
} from "./componentLibraryStore";

function entry(id: string, name = id): MyComponent {
  return { id, name, elements: [{ id: `${id}-el` } as never], created: 1, updated: 1 };
}

function fakeStore(initial?: unknown, failGet = false) {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set("components", initial);
  return {
    data,
    get: (async (k: string) => {
      if (failGet) throw new Error("disk on fire");
      return data.get(k);
    }) as <T>(k: string) => Promise<T | undefined>,
    set: vi.fn(async (k: string, v: unknown) => {
      data.set(k, v);
    }),
    save: vi.fn(async () => {}),
  };
}

describe("componentLibraryStore", () => {
  beforeEach(() => __resetMyComponentsForTest());

  it("loads stored components and drops malformed ones", async () => {
    const photo = {
      id: "f",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,x",
      created: 1,
    };
    __resetMyComponentsForTest(
      fakeStore([
        entry("a"),
        { id: "b" },
        { ...entry("c"), files: { f: photo } },
        { ...entry("d"), files: { f: { id: "f" } } },
      ]),
    );
    const loaded = await loadMyComponents();
    expect(loaded.map((c) => c.id)).toEqual(["a", "c"]);
    expect(loaded[1].files?.f).toEqual(photo);
  });

  it("never writes when loading failed (a damaged file isn't replaced)", async () => {
    const store = fakeStore([entry("a")], true);
    __resetMyComponentsForTest(store);
    await loadMyComponents();
    expect(canSaveMyComponents()).toBe(false);
    expect(await putMyComponent(entry("b"))).toBe(false);
    expect(store.set).not.toHaveBeenCalled();
    expect(getMyComponents()).toEqual([]);
  });

  it("never writes when the stored value isn't an array", async () => {
    const store = fakeStore({ nope: true });
    __resetMyComponentsForTest(store);
    expect(await putMyComponent(entry("b"))).toBe(false);
    expect(store.data.get("components")).toEqual({ nope: true });
  });

  it("adds, replaces in place (keeping created), renames and removes; notifies every tab", async () => {
    const store = fakeStore([entry("a")]);
    __resetMyComponentsForTest(store);
    const seen: string[][] = [];
    subscribeMyComponents((items) => seen.push(items.map((c) => `${c.id}:${c.name}`)));
    await putMyComponent(entry("b"));
    // Later loads see saves made after the first load.
    expect((await loadMyComponents()).map((c) => c.id)).toEqual(["a", "b"]);
    await putMyComponent({ ...entry("a", "Card"), created: 99 });
    expect(getMyComponents()[0]).toMatchObject({ id: "a", name: "Card", created: 1 });
    await renameMyComponent("b", "  Button  ");
    await removeMyComponent("a");
    expect(store.data.get("components")).toEqual([
      expect.objectContaining({ id: "b", name: "Button" }),
    ]);
    expect(seen[seen.length - 1]).toEqual(["b:Button"]);
    expect(seen).toContainEqual(["a:a"]);
    expect(store.save).toHaveBeenCalledTimes(4);
  });

  it("put waits for the load, so an early save never drops stored items", async () => {
    const store = fakeStore([entry("a")]);
    __resetMyComponentsForTest(store);
    await putMyComponent(entry("b"));
    expect((store.data.get("components") as MyComponent[]).map((c) => c.id)).toEqual(["a", "b"]);
  });
});
