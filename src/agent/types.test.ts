import { describe, expect, it } from "vitest";
import { CANVAS_TOOLS, CANVAS_TOOL_NAMES } from "./types";

describe("canvas tool contract", () => {
  it("tools.json and CANVAS_TOOL_NAMES list the same tools", () => {
    expect(CANVAS_TOOLS.map((t) => t.name)).toEqual([...CANVAS_TOOL_NAMES]);
  });
});
