import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above all top-level imports/declarations. To share
// a spy between the mock factory and the test cases, declare it via
// vi.hoisted() so it lives at the same hoisted scope.
const { restoreSpy } = vi.hoisted(() => ({
  restoreSpy: vi.fn((data: { elements?: unknown; appState?: unknown; files?: unknown } | null) => ({
    elements: Array.isArray(data?.elements) ? (data?.elements as unknown[]) : [],
    appState: {
      ...((data?.appState as Record<string, unknown>) ?? {}),
      collaborators:
        (data?.appState as Record<string, unknown> | undefined)?.collaborators ?? new Map(),
    },
    files: (data?.files as Record<string, unknown>) ?? {},
  })),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  restore: restoreSpy,
}));

import { restoreInitialData, sanitizeImportedAppState } from "./excalidrawRestore";

describe("sanitizeImportedAppState", () => {
  it("strips runtime-only keys that don't survive JSON.stringify", () => {
    const dirty = {
      collaborators: {}, // Map flattened to {}
      isLoading: true,
      errorMessage: "old error",
      pasteDialog: { open: true },
      // these are real serializable keys that must be preserved
      viewBackgroundColor: "#fafafa",
      zoom: { value: 1 },
    };
    const clean = sanitizeImportedAppState(dirty);
    expect(clean).not.toHaveProperty("collaborators");
    expect(clean).not.toHaveProperty("isLoading");
    expect(clean).not.toHaveProperty("errorMessage");
    expect(clean).not.toHaveProperty("pasteDialog");
    expect(clean.viewBackgroundColor).toBe("#fafafa");
    expect(clean.zoom).toEqual({ value: 1 });
  });

  it("returns an empty object for null/undefined/non-object input", () => {
    expect(sanitizeImportedAppState(null)).toEqual({});
    expect(sanitizeImportedAppState(undefined)).toEqual({});
    expect(sanitizeImportedAppState(42)).toEqual({});
    expect(sanitizeImportedAppState("string")).toEqual({});
  });
});

describe("restoreInitialData", () => {
  it("strips collaborators before delegating to Excalidraw's restore()", () => {
    restoreSpy.mockClear();
    const corrupted = JSON.parse(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [],
        appState: {
          collaborators: new Map([["user-1", { username: "alice" }]]),
          viewBackgroundColor: "#fff",
        },
        files: {},
      }),
    );
    // Precondition: post-JSON the Map is now a plain object.
    expect(corrupted.appState.collaborators).toEqual({});

    restoreInitialData(corrupted);

    // The critical assertion: by the time restore() is called, the
    // poisoned `collaborators` key has been stripped, so the helper's
    // fallback to `new Map()` can kick in.
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    const passed = restoreSpy.mock.calls[0]?.[0];
    expect(passed?.appState).toBeDefined();
    expect(passed?.appState).not.toHaveProperty("collaborators");
    // Non-runtime keys must still be forwarded.
    expect((passed?.appState as Record<string, unknown>).viewBackgroundColor).toBe("#fff");
  });

  it("returns an initialData state with a real Map for collaborators", () => {
    const restored = restoreInitialData({
      appState: { collaborators: {} },
    });
    const collaborators = restored.appState?.collaborators as unknown as Map<string, unknown>;
    expect(collaborators).toBeInstanceOf(Map);
    expect(typeof collaborators.forEach).toBe("function");
  });

  it("tolerates null/undefined input", () => {
    for (const input of [null, undefined]) {
      const r = restoreInitialData(input);
      expect(Array.isArray(r.elements)).toBe(true);
      expect(r.appState).toBeDefined();
      expect(r.appState?.collaborators).toBeInstanceOf(Map);
    }
  });

  it("preserves user-supplied elements through the restore pass", () => {
    const restored = restoreInitialData({
      elements: [{ id: "rect-1", type: "rectangle" }],
    });
    expect(restored.elements?.length).toBe(1);
    expect((restored.elements?.[0] as { id: string }).id).toBe("rect-1");
  });
});
