import { describe, it, expect } from "vitest";
import { sceneContentKey } from "./sceneContent";

const el = (id: string, version: number, versionNonce: number) => ({ id, version, versionNonce });

describe("sceneContentKey", () => {
  const bg = { viewBackgroundColor: "#ffffff" };

  it("ignores view-only changes such as selection or scroll", () => {
    const elements = [el("a", 3, 11)];
    expect(sceneContentKey(elements, bg, {})).toBe(sceneContentKey([el("a", 3, 11)], bg, {}));
  });

  it("changes when an element is edited, added or the background changes", () => {
    const base = sceneContentKey([el("a", 3, 11)], bg, {});
    expect(sceneContentKey([el("a", 4, 12)], bg, {})).not.toBe(base);
    expect(sceneContentKey([el("a", 3, 11), el("b", 1, 5)], bg, {})).not.toBe(base);
    expect(sceneContentKey([el("a", 3, 11)], { viewBackgroundColor: "#000" }, {})).not.toBe(base);
  });

  it("changes when a file is attached", () => {
    const base = sceneContentKey([], bg, {});
    const files = { f1: {} };
    expect(sceneContentKey([], bg, files)).not.toBe(base);
  });
});
