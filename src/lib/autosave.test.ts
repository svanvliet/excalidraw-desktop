import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutosaver } from "./autosave";

describe("createAutosaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces — only the latest schedule fires after delay", async () => {
    const writeFile = vi.fn(async () => {});
    const writeScratch = vi.fn(async () => {});
    let snap = 0;
    const snapshot = () => `snap-${snap}`;
    const saver = createAutosaver(
      {
        writeFile,
        writeScratch,
      },
      100,
    );
    saver.schedule({ tabId: "t1", path: "/a", snapshot });
    snap = 1;
    saver.schedule({ tabId: "t1", path: "/a", snapshot });
    snap = 2;
    saver.schedule({ tabId: "t1", path: "/a", snapshot });

    await vi.advanceTimersByTimeAsync(100);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith("/a", "snap-2");
    expect(writeScratch).not.toHaveBeenCalled();
  });

  it("routes untitled tabs to writeScratch", async () => {
    const writeFile = vi.fn(async () => {});
    const writeScratch = vi.fn(async () => {});
    const saver = createAutosaver(
      {
        writeFile,
        writeScratch,
      },
      50,
    );
    saver.schedule({ tabId: "t9", path: null, snapshot: () => "hello" });
    await vi.advanceTimersByTimeAsync(50);
    expect(writeScratch).toHaveBeenCalledWith("t9", "hello");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("skips the write when snapshot returns null", async () => {
    const writeFile = vi.fn(async () => {});
    const saver = createAutosaver(
      {
        writeFile,
        writeScratch: vi.fn(async () => {}),
      },
      10,
    );
    saver.schedule({ tabId: "t1", path: "/a", snapshot: () => null });
    await vi.advanceTimersByTimeAsync(10);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("cancel() prevents a scheduled write", async () => {
    const writeFile = vi.fn(async () => {});
    const saver = createAutosaver(
      {
        writeFile,
        writeScratch: vi.fn(async () => {}),
      },
      50,
    );
    saver.schedule({ tabId: "t1", path: "/a", snapshot: () => "x" });
    saver.cancel("t1");
    await vi.advanceTimersByTimeAsync(50);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("flush() runs the pending write immediately", async () => {
    const writeFile = vi.fn(async () => {});
    const saver = createAutosaver(
      {
        writeFile,
        writeScratch: vi.fn(async () => {}),
      },
      10_000,
    );
    saver.schedule({ tabId: "t1", path: "/a", snapshot: () => "x" });
    await saver.flush("t1");
    expect(writeFile).toHaveBeenCalledWith("/a", "x");
    // Flushing a second time is a no-op.
    await saver.flush("t1");
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("invokes onSaved after a successful write", async () => {
    const onSaved = vi.fn();
    const saver = createAutosaver(
      {
        writeFile: async () => {},
        writeScratch: async () => {},
        onSaved,
      },
      10,
    );
    saver.schedule({ tabId: "t1", path: "/a", snapshot: () => "x" });
    await vi.advanceTimersByTimeAsync(10);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ tabId: "t1", path: "/a" }));
  });

  it("invokes onError when the write throws", async () => {
    const onError = vi.fn();
    const boom = new Error("disk full");
    const saver = createAutosaver(
      {
        writeFile: async () => {
          throw boom;
        },
        writeScratch: async () => {},
        onError,
      },
      10,
    );
    saver.schedule({ tabId: "t1", path: "/a", snapshot: () => "x" });
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "t1", path: "/a" }),
      boom,
    );
  });

  it("cancelAll() drops every pending write", async () => {
    const writeFile = vi.fn(async () => {});
    const saver = createAutosaver(
      {
        writeFile,
        writeScratch: vi.fn(async () => {}),
      },
      50,
    );
    saver.schedule({ tabId: "t1", path: "/a", snapshot: () => "x" });
    saver.schedule({ tabId: "t2", path: "/b", snapshot: () => "y" });
    saver.cancelAll();
    await vi.advanceTimersByTimeAsync(50);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
