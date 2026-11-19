import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { onCollabStatus, isCollabStatus } from "./collabEvents";
import { COLLAB_STATUS_EVENT, COLLAB_STATUS_OFF } from "./commands";

describe("collabEvents", () => {
  beforeEach(() => {
    listenMock.mockReset().mockResolvedValue(() => {});
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("validates payload shape", () => {
    expect(isCollabStatus(COLLAB_STATUS_OFF)).toBe(true);
    expect(isCollabStatus({ running: true })).toBe(false);
    expect(isCollabStatus(null)).toBe(false);
  });

  it("forwards only well-formed payloads from collab://status", async () => {
    const handler = vi.fn();
    await onCollabStatus(handler);
    expect(listenMock).toHaveBeenCalledWith(COLLAB_STATUS_EVENT, expect.any(Function));
    const cb = listenMock.mock.calls[0][1] as (e: { payload: unknown }) => void;
    cb({ payload: { bogus: true } });
    cb({ payload: COLLAB_STATUS_OFF });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(COLLAB_STATUS_OFF);
  });

  it("is a no-op outside Tauri", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const unlisten = await onCollabStatus(vi.fn());
    expect(listenMock).not.toHaveBeenCalled();
    expect(typeof unlisten).toBe("function");
  });
});
