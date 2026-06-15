import { describe, it, expect, beforeEach, vi } from "vitest";

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
      if (value === undefined) {
        this.data.delete(key);
      } else {
        this.data.set(key, value);
      }
    }
    async save(): Promise<void> {}
  }
  return { LazyStore: FakeStore };
});

import { useThemeStore, __resetThemeForTests } from "./themeStore";
import { LazyStore } from "@tauri-apps/plugin-store";

type MqListener = (e: MediaQueryListEvent) => void;

class FakeMediaQueryList {
  private listeners: MqListener[] = [];
  constructor(public matches: boolean) {}
  addEventListener(_: "change", l: MqListener) {
    this.listeners.push(l);
  }
  removeEventListener(_: "change", l: MqListener) {
    this.listeners = this.listeners.filter((x) => x !== l);
  }
  dispatch(matches: boolean) {
    this.matches = matches;
    for (const l of this.listeners) {
      l({ matches } as MediaQueryListEvent);
    }
  }
}

let fakeMql: FakeMediaQueryList;

beforeEach(async () => {
  __resetThemeForTests();
  const wipe = new LazyStore("settings.json");
  await wipe.set("theme", undefined);
  await wipe.save();

  fakeMql = new FakeMediaQueryList(false);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation(() => fakeMql),
  });
  document.documentElement.removeAttribute("data-theme");
});

describe("themeStore", () => {
  it("defaults to system mode resolving to light when prefers-color-scheme is light", async () => {
    await useThemeStore.getState().load();
    expect(useThemeStore.getState().mode).toBe("system");
    expect(useThemeStore.getState().resolved).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("resolves system mode to dark when prefers-color-scheme is dark", async () => {
    fakeMql.matches = true;
    await useThemeStore.getState().load();
    expect(useThemeStore.getState().resolved).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("persists explicit mode and reads it back on next load", async () => {
    await useThemeStore.getState().load();
    await useThemeStore.getState().setMode("dark");
    expect(useThemeStore.getState().resolved).toBe("dark");

    __resetThemeForTests();
    await useThemeStore.getState().load();
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useThemeStore.getState().resolved).toBe("dark");
  });

  it("cycle steps system → light → dark → system", async () => {
    await useThemeStore.getState().load();
    expect(useThemeStore.getState().mode).toBe("system");
    await useThemeStore.getState().cycle();
    expect(useThemeStore.getState().mode).toBe("light");
    await useThemeStore.getState().cycle();
    expect(useThemeStore.getState().mode).toBe("dark");
    await useThemeStore.getState().cycle();
    expect(useThemeStore.getState().mode).toBe("system");
  });

  it("reacts to OS appearance change while in system mode", async () => {
    await useThemeStore.getState().load();
    expect(useThemeStore.getState().resolved).toBe("light");
    fakeMql.dispatch(true);
    expect(useThemeStore.getState().resolved).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores OS appearance change when mode is pinned", async () => {
    await useThemeStore.getState().load();
    await useThemeStore.getState().setMode("light");
    fakeMql.dispatch(true);
    expect(useThemeStore.getState().resolved).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("falls back to defaults when the persisted value is corrupted", async () => {
    const corrupt = new LazyStore("settings.json");
    await corrupt.set("theme", "neon-pink");
    await corrupt.save();

    await useThemeStore.getState().load();
    expect(useThemeStore.getState().mode).toBe("system");
  });
});
