import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => <div data-testid="excalidraw-mock" />,
}));

vi.mock("@excalidraw/excalidraw/index.css", () => ({}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./ipc/commands", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  isAppError: () => false,
}));

import { App } from "./App";
import { useTabsStore, __resetIdCounter } from "./stores/tabsStore";

beforeEach(() => {
  __resetIdCounter();
  useTabsStore.setState({
    tabs: [{ id: "boot", path: null, initialData: null, dirty: false }],
    activeTabId: null,
  });
});

describe("App", () => {
  it("renders the toolbar, tab bar, and a canvas slot for the only tab", () => {
    render(<App />);
    expect(screen.getByTestId("toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("tabbar")).toBeInTheDocument();
    // One Excalidraw per tab; with a single boot tab there's one mount.
    expect(screen.getAllByTestId("excalidraw-mock")).toHaveLength(1);
  });

  it("shows 'Untitled' in both the toolbar and the only tab before any file opens", () => {
    render(<App />);
    expect(screen.getAllByText("Untitled").length).toBeGreaterThanOrEqual(2);
  });
});
