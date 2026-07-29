import { describe, expect, it } from "vitest";

import { clampPanelPosition } from "./draggablePropertiesPanel";

describe("clampPanelPosition", () => {
  it("keeps the panel inside the container bounds", () => {
    const clamped = clampPanelPosition(
      { x: -20, y: 900 },
      { width: 220, height: 280 },
      { width: 1024, height: 640 },
    );
    expect(clamped).toEqual({ x: 8, y: 352 });
  });

  it("allows positions that are already valid", () => {
    const clamped = clampPanelPosition(
      { x: 120, y: 64 },
      { width: 180, height: 240 },
      { width: 900, height: 700 },
    );
    expect(clamped).toEqual({ x: 120, y: 64 });
  });

  it("pins to the padding when the panel is larger than the viewport", () => {
    const clamped = clampPanelPosition(
      { x: 200, y: 200 },
      { width: 900, height: 900 },
      { width: 700, height: 500 },
    );
    expect(clamped).toEqual({ x: 8, y: 8 });
  });
});
