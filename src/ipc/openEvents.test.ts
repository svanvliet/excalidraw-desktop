import { describe, it, expect, vi, beforeEach } from "vitest";

const listenMock = vi.fn();
const dragMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (...args: unknown[]) => dragMock(...args),
  }),
}));

import { FILE_OPEN_EVENT, onFileOpenRequest, onWindowFileDrop } from "./openEvents";

describe("onFileOpenRequest", () => {
  beforeEach(() => {
    listenMock.mockReset();
  });

  it("subscribes to the file-open channel and forwards string payloads", async () => {
    let registered: ((event: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation(async (_name, cb) => {
      registered = cb as typeof registered;
      return () => {};
    });

    const handler = vi.fn();
    await onFileOpenRequest(handler);

    expect(listenMock).toHaveBeenCalledWith(FILE_OPEN_EVENT, expect.any(Function));
    registered?.({ payload: "/tmp/x.excalidraw" });
    expect(handler).toHaveBeenCalledWith("/tmp/x.excalidraw");
  });

  it("ignores non-string payloads", async () => {
    let registered: ((event: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation(async (_name, cb) => {
      registered = cb as typeof registered;
      return () => {};
    });

    const handler = vi.fn();
    await onFileOpenRequest(handler);

    registered?.({ payload: 42 });
    registered?.({ payload: null });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("onWindowFileDrop", () => {
  beforeEach(() => {
    dragMock.mockReset();
  });

  it("only forwards 'drop' payloads, one per dropped path", async () => {
    let registered: ((event: { payload: unknown }) => void) | undefined;
    dragMock.mockImplementation(async (cb) => {
      registered = cb as typeof registered;
      return () => {};
    });

    const handler = vi.fn();
    await onWindowFileDrop(handler);

    registered?.({ payload: { type: "enter", paths: ["/a", "/b"], position: {} } });
    registered?.({ payload: { type: "over", position: {} } });
    registered?.({ payload: { type: "leave" } });
    expect(handler).not.toHaveBeenCalled();

    registered?.({
      payload: { type: "drop", paths: ["/x.excalidraw", "/y.png"], position: {} },
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, "/x.excalidraw");
    expect(handler).toHaveBeenNthCalledWith(2, "/y.png");
  });
});
