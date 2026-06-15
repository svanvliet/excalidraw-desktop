import { describe, it, expect, vi } from "vitest";
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

describe("App", () => {
  it("renders the toolbar and the Excalidraw canvas placeholder", () => {
    render(<App />);
    expect(screen.getByTestId("toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("excalidraw-mock")).toBeInTheDocument();
  });

  it("shows 'Untitled' before any file has been opened", () => {
    render(<App />);
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });
});
