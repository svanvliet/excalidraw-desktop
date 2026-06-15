import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Important: import dynamically inside each test so we can reset module
// state between cases (the logger memoizes the Tauri plugin promise).
async function freshLogger() {
  vi.resetModules();
  return await import("./logger");
}

describe("logger (non-Tauri fallback)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    // Strip any leftover Tauri marker.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("routes each level to the matching console method when not in Tauri", async () => {
    const { log } = await freshLogger();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(debugSpy).toHaveBeenCalledWith("d");
    expect(infoSpy).toHaveBeenCalledWith("i");
    expect(warnSpy).toHaveBeenCalledWith("w");
    expect(errorSpy).toHaveBeenCalledWith("e");
  });

  it("supports multiple args including Error objects", async () => {
    const { log } = await freshLogger();
    const err = new Error("boom");
    log.error("ctx", err, { extra: 1 });
    expect(errorSpy).toHaveBeenCalledWith("ctx", err, { extra: 1 });
  });

  it("installGlobalLogHandlers is idempotent and emits a boot banner", async () => {
    const { installGlobalLogHandlers } = await freshLogger();
    installGlobalLogHandlers();
    installGlobalLogHandlers();
    expect(infoSpy).toHaveBeenCalled();
    const firstCall = infoSpy.mock.calls[0]?.[0];
    expect(typeof firstCall).toBe("string");
    expect(firstCall as string).toMatch(/logger: boot/);
  });

  it("global handlers mirror console.warn/error into the Tauri log path (no-op outside Tauri)", async () => {
    const { installGlobalLogHandlers } = await freshLogger();
    installGlobalLogHandlers();
    // Outside Tauri the mirror is a console-only no-op; we just verify it
    // doesn't throw and the original console call still happens.
    console.warn("mirror-warn");
    console.error("mirror-error");
    expect(warnSpy).toHaveBeenCalledWith("mirror-warn");
    expect(errorSpy).toHaveBeenCalledWith("mirror-error");
  });
});
