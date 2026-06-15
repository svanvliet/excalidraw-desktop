import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

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
      if (value === undefined) this.data.delete(key);
      else this.data.set(key, value);
    }
    async save(): Promise<void> {}
  }
  return { LazyStore: FakeStore };
});

import { ThemeToggle } from "./ThemeToggle";
import { useThemeStore, __resetThemeForTests } from "../stores/themeStore";
import { LazyStore } from "@tauri-apps/plugin-store";

beforeEach(async () => {
  __resetThemeForTests();
  const wipe = new LazyStore("settings.json");
  await wipe.set("theme", undefined);
  await wipe.save();

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  });
});

describe("ThemeToggle", () => {
  it("renders with system mode by default", () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme-mode", "system");
  });

  it("cycles system → light → dark → system on click", async () => {
    render(<ThemeToggle />);
    const btn = screen.getByTestId("theme-toggle");

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(useThemeStore.getState().mode).toBe("light");
    expect(btn).toHaveAttribute("data-theme-mode", "light");

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(useThemeStore.getState().mode).toBe("dark");

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(useThemeStore.getState().mode).toBe("system");
  });

  it("announces the current mode and next action via aria-label", () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/system theme.*light theme/i),
    );
  });
});
