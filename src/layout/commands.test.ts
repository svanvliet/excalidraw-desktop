import "../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import spec from "./commands.json";
import { LAYOUT_COMMANDS, LAYOUT_MENU } from "./commands";
import { formatShortcut } from "./format";
import { MENU_ITEM_IDS } from "../ipc/menuEvents";

describe("Layout commands", () => {
  it("mirror commands.json in order, each with a run", () => {
    expect(LAYOUT_MENU.length).toBe(spec.length);
    expect(LAYOUT_COMMANDS.map((c) => c.id)).toEqual(
      spec.flatMap((e) => ("id" in e ? [e.id] : [])),
    );
    for (const c of LAYOUT_COMMANDS) {
      expect(c.id).toMatch(/^excalidraw:layout:/);
      expect(typeof c.run).toBe("function");
    }
  });

  it("are all native menu ids", () => {
    for (const c of LAYOUT_COMMANDS) expect(MENU_ITEM_IDS).toContain(c.id);
  });

  it("formats shortcuts per platform", () => {
    expect(formatShortcut("Alt+Shift+L", true)).toBe("⌥⇧L");
    expect(formatShortcut("Alt+Shift+L", false)).toBe("Alt+Shift+L");
  });
});
