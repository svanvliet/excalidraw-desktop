import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UpdateState } from "../ipc/commands";

const ipc = vi.hoisted(() => ({
  updateCheck: vi.fn<(manual: boolean) => Promise<UpdateState>>(),
  updateInstall: vi.fn<() => Promise<void>>(),
  // Never resolves, so tests own the store state.
  updateStatus: () => new Promise<UpdateState>(() => {}),
  menuHandler: null as ((id: string) => void) | null,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));
vi.mock("../ipc/commands", async (orig) => {
  const actual = await orig<typeof import("../ipc/commands")>();
  return {
    ...actual,
    updateCheck: (m: boolean) => ipc.updateCheck(m),
    updateInstall: () => ipc.updateInstall(),
    updateStatus: () => ipc.updateStatus(),
  };
});
vi.mock("../ipc/menuEvents", () => ({
  onMenuEvent: async (cb: (id: string) => void) => {
    ipc.menuHandler = cb;
    return () => {
      ipc.menuHandler = null;
    };
  },
}));

import { UPDATE_STATE_UNAVAILABLE } from "../ipc/commands";
import { UpdateController } from "./UpdateController";
import { UpdatesSection } from "./UpdatesSection";
import { __resetSettingsForTests, useSettingsStore } from "../stores/settingsStore";
import { __resetUpdateStoreForTests, useUpdateStore } from "../stores/updateStore";

const READY: Partial<UpdateState> = { enabled: true, status: "ready", version: "0.2.0" };

describe("UpdateController", () => {
  beforeEach(() => {
    __resetSettingsForTests();
    __resetUpdateStoreForTests();
    ipc.updateCheck.mockReset();
    ipc.updateInstall.mockReset().mockResolvedValue();
  });

  it("asks for consent once settings load in an updatable build, and remembers 'Not now'", async () => {
    render(<UpdateController />);
    expect(screen.queryByTestId("update-consent")).toBeNull();
    act(() => {
      useSettingsStore.setState({ loaded: true });
      useUpdateStore.setState({ enabled: true });
    });
    fireEvent.click(await screen.findByTestId("update-consent-no"));
    expect(useSettingsStore.getState().autoUpdate).toBe(false);
    expect(screen.queryByTestId("update-consent")).toBeNull();
    expect(ipc.updateCheck).not.toHaveBeenCalled();
  });

  it("never prompts in builds that can't update (dev / web preview)", () => {
    act(() => useSettingsStore.setState({ loaded: true }));
    render(<UpdateController />);
    expect(screen.queryByTestId("update-consent")).toBeNull();
  });

  it("offers Restart when an update is ready, flushing first", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    act(() => useUpdateStore.setState(READY));
    render(<UpdateController onBeforeRestart={flush} />);
    fireEvent.click(screen.getByTestId("update-restart"));
    await waitFor(() => expect(ipc.updateInstall).toHaveBeenCalled());
    expect(flush).toHaveBeenCalledBefore(ipc.updateInstall);
  });

  it("'Later' hides the ready toast without installing", () => {
    act(() => useUpdateStore.setState(READY));
    render(<UpdateController />);
    fireEvent.click(screen.getByText("Later"));
    expect(screen.queryByTestId("update-ready")).toBeNull();
    expect(ipc.updateInstall).not.toHaveBeenCalled();
  });

  it("the menu item runs a manual check and reports the result", async () => {
    ipc.updateCheck.mockResolvedValue({
      ...UPDATE_STATE_UNAVAILABLE,
      enabled: true,
      status: "upToDate",
    });
    render(<UpdateController />);
    await waitFor(() => expect(ipc.menuHandler).not.toBeNull());
    act(() => ipc.menuHandler?.("excalidraw:help:checkUpdates"));
    expect(ipc.updateCheck).toHaveBeenCalledWith(true);
    expect(await screen.findByText("You’re on the latest version.")).toBeTruthy();
  });
});

describe("UpdatesSection", () => {
  beforeEach(() => {
    __resetSettingsForTests();
    __resetUpdateStoreForTests();
    ipc.updateCheck.mockReset();
  });

  it("toggle reflects and records consent; unasked shows as off", () => {
    render(<UpdatesSection />);
    const toggle = screen.getByTestId<HTMLInputElement>("toggle-auto-update");
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().autoUpdate).toBe(true);
  });

  it("disables Check now in dev builds", () => {
    render(<UpdatesSection />);
    expect(screen.getByTestId<HTMLButtonElement>("update-check-now").disabled).toBe(true);
    expect(screen.getByText(/unavailable in development/)).toBeTruthy();
  });

  it("shows version, progress, and errors", () => {
    act(() =>
      useUpdateStore.setState({
        enabled: true,
        currentVersion: "0.1.1",
        status: "downloading",
        version: "0.2.0",
        progress: 0.42,
      }),
    );
    const { rerender } = render(<UpdatesSection />);
    expect(screen.getByText("Version 0.1.1")).toBeTruthy();
    expect(screen.getByTestId("update-status").textContent).toContain("42%");
    act(() => useUpdateStore.setState({ status: "error", error: "Couldn’t reach the server." }));
    rerender(<UpdatesSection />);
    expect(screen.getByTestId("update-status").textContent).toBe("Couldn’t reach the server.");
  });
});
