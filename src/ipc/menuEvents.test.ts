/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  MENU_EVENT,
  MENU_ITEM_IDS,
  isMenuItemId,
  onMenuEvent,
  dispatchShortcut,
} from "./menuEvents";

describe("menuEvents", () => {
  beforeEach(() => {
    listenMock.mockReset();
  });

  it("exposes the same event name the Rust side emits", () => {
    expect(MENU_EVENT).toBe("excalidraw://menu");
  });

  it("MENU_ITEM_IDS covers every supported handler ID", () => {
    // Drift detector: matches src-tauri/src/menu.rs `ids::*` constants.
    expect(MENU_ITEM_IDS).toEqual([
      "excalidraw:file:new",
      "excalidraw:file:open",
      "excalidraw:file:save",
      "excalidraw:file:saveAs",
      "excalidraw:file:exportPng",
      "excalidraw:file:closeTab",
      "excalidraw:file:settings",
      "excalidraw:edit:undo",
      "excalidraw:edit:redo",
      "excalidraw:view:zoomIn",
      "excalidraw:view:zoomOut",
      "excalidraw:view:zoomReset",
      "excalidraw:help:about",
      "excalidraw:help:docs",
    ]);
  });

  it("isMenuItemId only accepts known IDs", () => {
    expect(isMenuItemId("excalidraw:file:new")).toBe(true);
    expect(isMenuItemId("excalidraw:bogus:thing")).toBe(false);
    expect(isMenuItemId(undefined)).toBe(false);
    expect(isMenuItemId(123)).toBe(false);
  });

  it("onMenuEvent forwards typed payloads and ignores unknown ones", async () => {
    let captured: ((event: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementation(async (_name: string, cb: any) => {
      captured = cb;
      return () => {};
    });
    const handler = vi.fn();
    await onMenuEvent(handler);
    captured!({ payload: "excalidraw:file:save" });
    captured!({ payload: "excalidraw:nope" });
    captured!({ payload: 42 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("excalidraw:file:save");
  });

  it("dispatchShortcut fires a KeyboardEvent on the chosen target with platform modifier", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const events: KeyboardEvent[] = [];
    target.addEventListener("keydown", (e) => events.push(e));

    dispatchShortcut({ key: "z", target });
    dispatchShortcut({ key: "z", shift: true, target });
    dispatchShortcut({ key: "=", target });

    expect(events).toHaveLength(3);
    expect(events[0].key).toBe("z");
    expect(events[0].code).toBe("KeyZ");
    // jsdom defaults to a generic platform string; either metaKey OR
    // ctrlKey must be set when `mod` is true (the default).
    expect(events[0].metaKey || events[0].ctrlKey).toBe(true);
    expect(events[0].shiftKey).toBe(false);
    expect(events[1].shiftKey).toBe(true);
    expect(events[2].code).toBe("Equal");

    document.body.removeChild(target);
  });

  it("dispatchShortcut can suppress the modifier when mod=false", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    let evt: KeyboardEvent | null = null;
    target.addEventListener("keydown", (e) => (evt = e));
    dispatchShortcut({ key: "f", mod: false, target });
    expect(evt).not.toBeNull();
    expect(evt!.metaKey).toBe(false);
    expect(evt!.ctrlKey).toBe(false);
    document.body.removeChild(target);
  });
});
