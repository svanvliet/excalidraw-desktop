import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => {
  // Path-keyed so tests can talk to the same underlying "file" the store
  // module is using. Mirrors plugin-store's per-path singleton semantics.
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

import { useSettingsStore, __resetSettingsForTests } from "./settingsStore";
import { LazyStore } from "@tauri-apps/plugin-store";

describe("settingsStore", () => {
  beforeEach(async () => {
    __resetSettingsForTests();
    // Wipe the path-keyed fake store between tests so persisted writes
    // from a prior test don't leak in.
    const wipe = new LazyStore("settings.json");
    await wipe.set("settings", undefined);
    await wipe.save();
  });

  it("every online toggle defaults to false on a fresh install", () => {
    const s = useSettingsStore.getState();
    // The privacy invariant. If this test breaks, the app is no longer
    // offline-by-default — DO NOT just update the assertion.
    expect(s.collab).toBe(false);
    expect(s.library).toBe(false);
    expect(s.ai).toBe(false);
    expect(s.openAiKey).toBe("");
    expect(s.firebaseConfig).toBe("");
    expect(s.loaded).toBe(false);
  });

  it("load() marks loaded=true even when the store has no prior data", async () => {
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.collab).toBe(false);
  });

  it("setFlag flips a single online feature and persists it across reloads", async () => {
    await useSettingsStore.getState().load();
    await useSettingsStore.getState().setFlag("collab", true);
    expect(useSettingsStore.getState().collab).toBe(true);
    // Simulate relaunch: drop in-memory state, then load again.
    useSettingsStore.setState({ collab: false, loaded: false });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().collab).toBe(true);
  });

  it("setSecret stores secrets independently of the online toggles", async () => {
    await useSettingsStore.getState().load();
    await useSettingsStore.getState().setSecret("openAiKey", "sk-test-123");
    expect(useSettingsStore.getState().openAiKey).toBe("sk-test-123");
    expect(useSettingsStore.getState().ai).toBe(false);
  });

  it("resetAll restores defaults and persists the reset", async () => {
    await useSettingsStore.getState().load();
    await useSettingsStore.getState().setFlag("library", true);
    await useSettingsStore.getState().setSecret("openAiKey", "sk-zap");
    await useSettingsStore.getState().resetAll();
    expect(useSettingsStore.getState().library).toBe(false);
    expect(useSettingsStore.getState().openAiKey).toBe("");
    // Reload check.
    useSettingsStore.setState({ library: true, openAiKey: "leak", loaded: false });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().library).toBe(false);
    expect(useSettingsStore.getState().openAiKey).toBe("");
  });

  it("sanitize ignores wrong-typed persisted values", async () => {
    // Seed the fake store with garbage and confirm we fall back to defaults
    // for each malformed field.
    const { LazyStore } = await import("@tauri-apps/plugin-store");
    const direct = new LazyStore("settings.json");
    await direct.set("settings", {
      collab: "yes" as unknown as boolean,
      library: null as unknown as boolean,
      ai: 1 as unknown as boolean,
      openAiKey: 42 as unknown as string,
      firebaseConfig: { not: "a string" } as unknown as string,
    });
    await direct.save();
    // Re-construct the store so we pick up the same shared fake.
    useSettingsStore.setState({ loaded: false });
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.collab).toBe(false);
    expect(s.library).toBe(false);
    expect(s.ai).toBe(false);
    expect(s.openAiKey).toBe("");
    expect(s.firebaseConfig).toBe("");
  });
});
