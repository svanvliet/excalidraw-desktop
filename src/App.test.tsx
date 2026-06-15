import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => <div data-testid="excalidraw-mock" />,
  exportToBlob: vi.fn(async () => new Blob()),
  loadFromBlob: vi.fn(async () => ({ elements: [], appState: {}, files: {} })),
  // Used by `src/lib/excalidrawRestore.ts`. Real Excalidraw rebuilds the
  // collaborators Map and normalizes appState here; the stub is enough
  // for App-level smoke testing.
  restore: (data: { elements?: unknown; appState?: unknown; files?: unknown } | null) => ({
    elements: Array.isArray(data?.elements) ? (data?.elements as unknown[]) : [],
    appState: {
      ...((data?.appState as Record<string, unknown>) ?? {}),
      collaborators: new Map(),
    },
    files: (data?.files as Record<string, unknown>) ?? {},
  }),
}));

vi.mock("@excalidraw/excalidraw/index.css", () => ({}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async () => () => {}),
  }),
}));

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeStore {
    private data = new Map<string, unknown>();
    async get<T>(key: string): Promise<T | undefined> {
      return this.data.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      this.data.set(key, value);
    }
    async save(): Promise<void> {}
  }
  return { LazyStore: FakeStore, Store: FakeStore };
});

vi.mock("./ipc/commands", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  readFileBytes: vi.fn(),
  writeFileBytes: vi.fn(),
  writeScratch: vi.fn(),
  readScratch: vi.fn(),
  deleteScratch: vi.fn(),
  listScratch: vi.fn(async () => []),
  isAppError: () => false,
}));

import { App } from "./App";
import { useTabsStore, __resetIdCounter } from "./stores/tabsStore";
import { useRecentFilesStore } from "./stores/recentFilesStore";

beforeEach(() => {
  __resetIdCounter();
  useTabsStore.setState({
    tabs: [{ id: "boot", path: null, initialData: null, dirty: false }],
    activeTabId: null,
  });
  useRecentFilesStore.setState({ paths: [] });
});

describe("App", () => {
  it("renders the toolbar, tab bar, and a canvas slot for the only tab", async () => {
    render(<App />);
    expect(screen.getByTestId("toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("tabbar")).toBeInTheDocument();
    // One Excalidraw per tab; with a single boot tab there's one mount.
    expect(screen.getAllByTestId("excalidraw-mock")).toHaveLength(1);
    // Flush the async loadRecent() effect to keep React quiet.
    await waitFor(() => expect(useRecentFilesStore.getState().paths).toEqual([]));
  });

  it("shows 'Untitled' in both the toolbar and the only tab before any file opens", async () => {
    render(<App />);
    expect(screen.getAllByText("Untitled").length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(useRecentFilesStore.getState().paths).toEqual([]));
  });
});
