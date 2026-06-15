import { describe, it, expect, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  exportToBlob: vi.fn(async (opts: { appState: Record<string, unknown> }) => {
    // Echo the merged appState back through the blob "type" so the test can
    // assert that exportEmbedScene was forced on without needing a real PNG.
    return new Blob([JSON.stringify(opts.appState)], { type: "image/png" });
  }),
  loadFromBlob: vi.fn(async () => ({
    elements: [{ id: "from-png" }],
    appState: { viewBackgroundColor: "#abc" },
    files: { "file-1": {} },
  })),
}));

import { exportSceneAsPng, loadScenePng } from "./pngScene";

const fakeApi = {
  getAppState: () => ({ exportEmbedScene: false, viewBackgroundColor: "#fff" }),
  getSceneElements: () => [{ id: "el-1" }],
  getFiles: () => ({}),
} as unknown as import("@excalidraw/excalidraw/types").ExcalidrawImperativeAPI;

describe("exportSceneAsPng", () => {
  it("forces exportEmbedScene=true even when the editor has it off", async () => {
    const { exportToBlob } = await import("@excalidraw/excalidraw");
    await exportSceneAsPng(fakeApi);
    const calls = (exportToBlob as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const opts = calls[calls.length - 1][0] as { appState: Record<string, unknown> };
    expect(opts.appState.exportEmbedScene).toBe(true);
    expect(opts.appState.viewBackgroundColor).toBe("#fff");
  });
});

describe("loadScenePng", () => {
  it("returns an InitialDataState reconstructed from the blob", async () => {
    const bytes = new Uint8Array([0x89, 0x50]);
    const result = await loadScenePng(bytes);
    expect(result).not.toBeNull();
    expect(result?.elements).toEqual([{ id: "from-png" }]);
    expect((result?.appState as { viewBackgroundColor?: string }).viewBackgroundColor).toBe("#abc");
  });

  it("returns null when loadFromBlob throws (corrupt PNG / no scene)", async () => {
    const { loadFromBlob } = await import("@excalidraw/excalidraw");
    (loadFromBlob as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no scene"));
    const result = await loadScenePng(new Uint8Array([0]));
    expect(result).toBeNull();
  });
});
