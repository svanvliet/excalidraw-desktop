import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

const COLLAB_OFF = vi.hoisted(() => ({
  running: false,
  roomId: null,
  localPort: null,
  localBase: null,
  publicBase: null,
  tunnel: { mode: null, state: "off", error: null },
  peerCount: 0,
}));
vi.mock("./ipc/commands", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  readFileBytes: vi.fn(),
  writeFileBytes: vi.fn(),
  writeScratch: vi.fn(),
  readScratch: vi.fn(),
  deleteScratch: vi.fn(async () => {}),
  listScratch: vi.fn(async () => []),
  isAppError: () => false,
  isTauri: () => false,
  appProfile: vi.fn(async () => null),
  collabStatus: vi.fn(async () => COLLAB_OFF),
  collabStop: vi.fn(async () => COLLAB_OFF),
  collabStart: vi.fn(),
  COLLAB_STATUS_OFF: COLLAB_OFF,
  UPDATE_STATE_UNAVAILABLE: { status: "idle", currentVersion: "", enabled: false },
  updateStatus: vi.fn(() => new Promise(() => {})),
  updateCheck: vi.fn(),
  updateInstall: vi.fn(),
}));

import { App } from "./App";
import { useTabsStore, __resetIdCounter } from "./stores/tabsStore";
import { useRecentFilesStore } from "./stores/recentFilesStore";
import { useCollabStore, __resetCollabStoreForTests } from "./stores/collabStore";
import { useSettingsStore, __resetSettingsForTests } from "./stores/settingsStore";
import { collabStop } from "./ipc/commands";

beforeEach(() => {
  __resetIdCounter();
  useTabsStore.setState({
    tabs: [{ id: "boot", path: null, initialData: null, dirty: false }],
    activeTabId: null,
  });
  useRecentFilesStore.setState({ paths: [] });
  __resetCollabStoreForTests();
  __resetSettingsForTests();
  vi.mocked(collabStop).mockClear();
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

  it("joining a session opens a new tab bound to it as guest", async () => {
    render(<App />);
    await waitFor(() => expect(useRecentFilesStore.getState().paths).toEqual([]));
    useSettingsStore.setState({ collab: true });
    fireEvent.click(screen.getByTestId("toolbar-join"));
    fireEvent.change(screen.getByTestId("join-link"), {
      target: {
        value: "https://x.devtunnels.ms/#room=0123456789abcdef0123,AAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    fireEvent.click(screen.getByTestId("join-submit"));
    const { tabs, activeTabId } = useTabsStore.getState();
    expect(tabs).toHaveLength(2);
    expect(useCollabStore.getState().session).toMatchObject({ role: "guest", tabId: activeTabId });
  });

  it("closing the hosting tab stops the session", async () => {
    render(<App />);
    await waitFor(() => expect(useRecentFilesStore.getState().paths).toEqual([]));
    useCollabStore.setState({
      session: {
        role: "host",
        tabId: "boot",
        roomId: "0123456789abcdef0123",
        key: "AAAAAAAAAAAAAAAAAAAAAA",
        publicBase: null,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close Untitled" }));
    await waitFor(() => expect(collabStop).toHaveBeenCalledTimes(1));
    expect(useCollabStore.getState().session).toBeNull();
  });
});
