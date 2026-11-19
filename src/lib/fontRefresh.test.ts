import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshTextElements, watchFontLoads } from "./fontRefresh";

describe("refreshTextElements", () => {
  it("re-issues text elements with new identities and leaves others untouched", () => {
    const rect = { type: "rectangle", id: "r", version: 3 };
    const text = { type: "text", id: "t", version: 7 };
    const updateScene = vi.fn();
    const api = { getSceneElementsIncludingDeleted: () => [rect, text], updateScene };

    expect(refreshTextElements(api, "NEVER")).toBe(true);
    const { elements, captureUpdate } = updateScene.mock.calls[0][0];
    expect(captureUpdate).toBe("NEVER");
    expect(elements[0]).toBe(rect);
    expect(elements[1]).not.toBe(text);
    expect(elements[1]).toEqual(text);
  });

  it("skips scenes without text", () => {
    const updateScene = vi.fn();
    const api = { getSceneElementsIncludingDeleted: () => [{ type: "ellipse" }], updateScene };
    expect(refreshTextElements(api, "NEVER")).toBe(false);
    expect(updateScene).not.toHaveBeenCalled();
  });
});

describe("watchFontLoads", () => {
  afterEach(() => vi.useRealTimers());

  function fakeFonts() {
    const target = new EventTarget();
    return Object.assign(target, { ready: Promise.resolve() }) as unknown as FontFaceSet;
  }

  it("refreshes after fonts settle and on each loadingdone, until disposed", async () => {
    vi.useFakeTimers();
    const fonts = fakeFonts();
    const refresh = vi.fn();
    const stop = watchFontLoads(refresh, fonts);

    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).toHaveBeenCalledTimes(1);

    fonts.dispatchEvent(new Event("loadingdone"));
    fonts.dispatchEvent(new Event("loadingdone"));
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    fonts.dispatchEvent(new Event("loadingdone"));
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
