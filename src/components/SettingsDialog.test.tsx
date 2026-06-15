import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-store", () => {
  const byPath = new Map<string, Map<string, unknown>>();
  class FakeStore {
    private data: Map<string, unknown>;
    constructor(path: string) {
      let bucket = byPath.get(path);
      if (!bucket) {
        bucket = new Map();
        byPath.set(path, bucket);
      }
      this.data = bucket;
    }
    async get<T>(key: string): Promise<T | undefined> {
      return this.data.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      this.data.set(key, value);
    }
    async save(): Promise<void> {}
  }
  return { LazyStore: FakeStore };
});

import { SettingsDialog } from "./SettingsDialog";
import { useSettingsStore, __resetSettingsForTests } from "../stores/settingsStore";
import { LazyStore } from "@tauri-apps/plugin-store";

describe("SettingsDialog", () => {
  beforeEach(async () => {
    __resetSettingsForTests();
    const wipe = new LazyStore("settings.json");
    await wipe.set("settings", undefined);
    await wipe.save();
  });

  it("does not render when open is false", () => {
    render(<SettingsDialog open={false} onClose={() => {}} />);
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("shows all three online-feature toggles in the off position by default", () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    expect(screen.getByTestId<HTMLInputElement>("toggle-collab").checked).toBe(false);
    expect(screen.getByTestId<HTMLInputElement>("toggle-library").checked).toBe(false);
    expect(screen.getByTestId<HTMLInputElement>("toggle-ai").checked).toBe(false);
  });

  it("toggling a feature persists to the store", async () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("toggle-ai"));
    await waitFor(() => expect(useSettingsStore.getState().ai).toBe(true));
  });

  it("typing into the OpenAI key field updates the secret", async () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("secret-openai"), {
      target: { value: "sk-typed" },
    });
    await waitFor(() => expect(useSettingsStore.getState().openAiKey).toBe("sk-typed"));
  });

  it("Reset all puts every toggle and secret back to its default", async () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("toggle-collab"));
    fireEvent.change(screen.getByTestId("secret-openai"), {
      target: { value: "sk-leak" },
    });
    await waitFor(() => expect(useSettingsStore.getState().collab).toBe(true));

    fireEvent.click(screen.getByTestId("settings-reset"));
    await waitFor(() => {
      expect(useSettingsStore.getState().collab).toBe(false);
      expect(useSettingsStore.getState().openAiKey).toBe("");
    });
  });

  it("Done invokes onClose", () => {
    const onClose = vi.fn();
    render(<SettingsDialog open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("settings-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key invokes onClose while the dialog is open", () => {
    const onClose = vi.fn();
    render(<SettingsDialog open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop click invokes onClose; the dialog body click does not", () => {
    const onClose = vi.fn();
    render(<SettingsDialog open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("settings-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Settings"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
