import { describe, expect, it, vi } from "vitest";

// Mock the heavy upstream module — vitest can't import it whole because
// its top-level pulls in the entire React UI. We only need `restore`, and
// we model it to mirror the relevant real behavior (rebuilds
// `collaborators` as a Map). The integration of our wrapper with the
// real `restore` is exercised by the running app at boot.
vi.mock("@excalidraw/excalidraw", () => ({
  restore: (data: { elements?: unknown; appState?: unknown; files?: unknown } | null) => ({
    elements: Array.isArray(data?.elements) ? (data?.elements as unknown[]) : [],
    appState: {
      ...((data?.appState as Record<string, unknown>) ?? {}),
      // The whole point of this helper: collaborators is always a Map.
      collaborators: new Map(),
    },
    files: (data?.files as Record<string, unknown>) ?? {},
  }),
}));

import { restoreInitialData } from "./excalidrawRestore";

describe("restoreInitialData", () => {
  it("rebuilds appState.collaborators as a Map after a JSON round-trip", () => {
    // Reproduces the blank-screen bug: a Map serialized via JSON.stringify
    // becomes `{}`, and Excalidraw then calls .forEach on it and throws.
    const corrupted = JSON.parse(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [],
        appState: {
          collaborators: new Map([["user-1", { username: "alice" }]]),
        },
        files: {},
      }),
    );
    // Precondition: post-JSON the Map is now a plain object without
    // .forEach, which is exactly what was crashing the app.
    expect(corrupted.appState.collaborators).toEqual({});
    expect(typeof corrupted.appState.collaborators.forEach).toBe("undefined");

    const restored = restoreInitialData(corrupted);
    const collaborators = restored.appState?.collaborators as unknown as Map<string, unknown>;
    expect(collaborators).toBeInstanceOf(Map);
    expect(typeof collaborators.forEach).toBe("function");
  });

  it("tolerates null/undefined input and returns a usable default state", () => {
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
