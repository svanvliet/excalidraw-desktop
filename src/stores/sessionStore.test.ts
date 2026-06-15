import { describe, it, expect, vi, beforeEach } from "vitest";

// `sessionStore` transitively imports `@excalidraw/excalidraw` via the
// `restoreInitialData` helper. The package's top-level deep-loads
// `open-color.json` which Node's ESM loader can't read without an
// `assert { type: "json" }` attribute, so we stub it here.
vi.mock("@excalidraw/excalidraw", () => ({
  restore: (data: { elements?: unknown; appState?: unknown; files?: unknown } | null) => ({
    elements: Array.isArray(data?.elements) ? (data?.elements as unknown[]) : [],
    appState: {
      ...((data?.appState as Record<string, unknown>) ?? {}),
      collaborators: new Map(),
    },
    files: (data?.files as Record<string, unknown>) ?? {},
  }),
}));

import {
  snapshotSession,
  persistSession,
  readPersistedSession,
  restoreSession,
  __setSessionStoreForTest,
} from "./sessionStore";
import { useTabsStore, __resetIdCounter } from "./tabsStore";

vi.mock("../ipc/commands", () => ({
  openFile: vi.fn(),
  listScratch: vi.fn(),
  isAppError: () => false,
}));

import { openFile, listScratch } from "../ipc/commands";

describe("snapshotSession", () => {
  it("projects tabs to {id, path} and preserves activeTabId", () => {
    const result = snapshotSession(
      [
        { id: "a", path: "/x", dirty: false, initialData: null },
        { id: "b", path: null, dirty: true, initialData: null },
      ],
      "b",
    );
    expect(result).toEqual({
      tabs: [
        { id: "a", path: "/x" },
        { id: "b", path: null },
      ],
      activeTabId: "b",
    });
  });
});

describe("session persistence + restore", () => {
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
    __setSessionStoreForTest(fakeStore as any);
    __resetIdCounter();
    useTabsStore.setState({
      tabs: [{ id: "boot", path: null, dirty: false, initialData: null }],
      activeTabId: "boot",
    });
    vi.mocked(openFile).mockReset();
    vi.mocked(listScratch).mockReset();
  });

  it("persistSession writes the current tabs to the store", async () => {
    useTabsStore.setState({
      tabs: [
        { id: "a", path: "/x.excalidraw", dirty: false, initialData: null },
        { id: "b", path: null, dirty: true, initialData: null },
      ],
      activeTabId: "a",
    });
    await persistSession();
    const saved = fakeStore.storage["v1"];
    expect(saved).toEqual({
      tabs: [
        { id: "a", path: "/x.excalidraw" },
        { id: "b", path: null },
      ],
      activeTabId: "a",
    });
  });

  it("readPersistedSession returns null when nothing is saved", async () => {
    expect(await readPersistedSession()).toBeNull();
  });

  it("restoreSession with no prior session is a no-op", async () => {
    const result = await restoreSession();
    expect(result).toEqual({ restored: 0, skipped: 0 });
    // The boot tab is left intact.
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("restoreSession reopens file-backed tabs", async () => {
    fakeStore.storage["v1"] = {
      tabs: [
        { id: "x1", path: "/a.excalidraw" },
        { id: "x2", path: "/b.excalidraw" },
      ],
      activeTabId: "x2",
    };
    vi.mocked(openFile).mockImplementation(async (p: string) => ({
      path: p,
      contents: JSON.stringify({ type: "excalidraw", version: 2, elements: [] }),
    }));
    vi.mocked(listScratch).mockResolvedValue([]);

    const result = await restoreSession();
    expect(result).toEqual({ restored: 2, skipped: 0 });
    const { tabs, activeTabId } = useTabsStore.getState();
    expect(tabs.map((t) => t.path)).toEqual(["/a.excalidraw", "/b.excalidraw"]);
    expect(activeTabId).toBe("x2");
  });

  it("restoreSession skips files that no longer exist", async () => {
    fakeStore.storage["v1"] = {
      tabs: [
        { id: "ok", path: "/here.excalidraw" },
        { id: "gone", path: "/missing.excalidraw" },
      ],
      activeTabId: "ok",
    };
    vi.mocked(openFile).mockImplementation(async (p: string) => {
      if (p === "/missing.excalidraw") {
        throw { kind: "io", path: p, message: "no such file" };
      }
      return {
        path: p,
        contents: JSON.stringify({ type: "excalidraw", version: 2, elements: [] }),
      };
    });
    vi.mocked(listScratch).mockResolvedValue([]);

    const result = await restoreSession();
    expect(result).toEqual({ restored: 1, skipped: 1 });
    expect(useTabsStore.getState().tabs.map((t) => t.path)).toEqual(["/here.excalidraw"]);
  });

  it("restoreSession recovers untitled tabs from scratch by tab id", async () => {
    fakeStore.storage["v1"] = {
      tabs: [{ id: "u1", path: null }],
      activeTabId: "u1",
    };
    vi.mocked(listScratch).mockResolvedValue([
      {
        key: "u1",
        contents: JSON.stringify({ type: "excalidraw", version: 2, elements: [] }),
      },
    ]);

    const result = await restoreSession();
    expect(result).toEqual({ restored: 1, skipped: 0 });
    const { tabs } = useTabsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].path).toBeNull();
    // Recovered-untitled tabs start dirty so the user knows to do a real Save.
    expect(tabs[0].dirty).toBe(true);
  });

  it("falls back to the first restored tab when the saved active id is missing", async () => {
    fakeStore.storage["v1"] = {
      tabs: [{ id: "a", path: "/a.excalidraw" }],
      activeTabId: "vanished",
    };
    vi.mocked(openFile).mockResolvedValue({
      path: "/a.excalidraw",
      contents: JSON.stringify({ type: "excalidraw", version: 2, elements: [] }),
    });
    vi.mocked(listScratch).mockResolvedValue([]);

    await restoreSession();
    expect(useTabsStore.getState().activeTabId).toBe("a");
  });
});
