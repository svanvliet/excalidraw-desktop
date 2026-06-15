import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pushRecent,
  removeRecent,
  useRecentFilesStore,
  __setStoreForTest,
  MAX_RECENT,
} from "./recentFilesStore";

describe("pushRecent", () => {
  it("prepends a new path", () => {
    expect(pushRecent([], "/a")).toEqual(["/a"]);
    expect(pushRecent(["/b"], "/a")).toEqual(["/a", "/b"]);
  });

  it("dedupes — re-adding an existing path moves it to the front", () => {
    expect(pushRecent(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
  });

  it("caps at MAX_RECENT entries (default 20)", () => {
    const initial = Array.from({ length: 20 }, (_, i) => `/p/${i}`);
    const result = pushRecent(initial, "/new");
    expect(result).toHaveLength(MAX_RECENT);
    expect(result[0]).toBe("/new");
    expect(result).not.toContain("/p/19");
  });

  it("ignores empty paths", () => {
    expect(pushRecent(["/a"], "")).toEqual(["/a"]);
  });

  it("respects a custom cap", () => {
    expect(pushRecent(["/a", "/b", "/c"], "/d", 2)).toEqual(["/d", "/a"]);
  });
});

describe("removeRecent", () => {
  it("removes the given path and leaves others intact", () => {
    expect(removeRecent(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
  });

  it("is a no-op when the path isn't present", () => {
    expect(removeRecent(["/a"], "/missing")).toEqual(["/a"]);
  });
});

describe("useRecentFilesStore", () => {
  let fakeStore: {
    storage: Record<string, unknown>;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    fakeStore = {
      storage: {},
      get: vi.fn(async (key: string) => fakeStore.storage[key]),
      set: vi.fn(async (key: string, value: unknown) => {
        fakeStore.storage[key] = value;
      }),
      save: vi.fn(async () => {}),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __setStoreForTest(fakeStore as any);
    useRecentFilesStore.setState({ paths: [] });
  });

  it("load() reads the persisted array into the store", async () => {
    fakeStore.storage["paths"] = ["/x", "/y"];
    await useRecentFilesStore.getState().load();
    expect(useRecentFilesStore.getState().paths).toEqual(["/x", "/y"]);
  });

  it("load() defaults to empty when nothing is persisted", async () => {
    await useRecentFilesStore.getState().load();
    expect(useRecentFilesStore.getState().paths).toEqual([]);
  });

  it("add() updates memory and persists", async () => {
    await useRecentFilesStore.getState().add("/a");
    await useRecentFilesStore.getState().add("/b");
    expect(useRecentFilesStore.getState().paths).toEqual(["/b", "/a"]);
    expect(fakeStore.set).toHaveBeenLastCalledWith("paths", ["/b", "/a"]);
    expect(fakeStore.save).toHaveBeenCalled();
  });

  it("remove() drops the path and persists", async () => {
    useRecentFilesStore.setState({ paths: ["/a", "/b", "/c"] });
    await useRecentFilesStore.getState().remove("/b");
    expect(useRecentFilesStore.getState().paths).toEqual(["/a", "/c"]);
    expect(fakeStore.set).toHaveBeenLastCalledWith("paths", ["/a", "/c"]);
  });

  it("clear() empties the list", async () => {
    useRecentFilesStore.setState({ paths: ["/a", "/b"] });
    await useRecentFilesStore.getState().clear();
    expect(useRecentFilesStore.getState().paths).toEqual([]);
    expect(fakeStore.set).toHaveBeenLastCalledWith("paths", []);
  });
});
