import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgePanelKeys, isTextTarget, PANEL_HOST_ATTR } from "./keyboard";

let container: HTMLDivElement;
let host: HTMLDivElement;
let seen: KeyboardEvent[];
let cleanup: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  container.tabIndex = 0;
  host = document.createElement("div");
  host.setAttribute(PANEL_HOST_ATTR, "");
  host.innerHTML = `<button>b</button><input type="range"><input type="text"><textarea></textarea>`;
  container.append(document.createElement("canvas"), host);
  document.body.append(container);
  seen = [];
  container.addEventListener("keydown", (e) => {
    if (e.target === container) {
      seen.push(e);
      e.preventDefault();
    }
  });
  cleanup = bridgePanelKeys(container);
});
afterEach(() => {
  cleanup();
  container.remove();
  vi.useRealTimers();
});

const press = (target: Element, init: KeyboardEventInit) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const q = (sel: string) => host.querySelector<HTMLElement>(sel)!;

describe("panel keyboard bridge", () => {
  it("forwards Ctrl/Cmd shortcuts from buttons and sliders to Excalidraw's container", () => {
    const original = press(q("button"), { key: "z", code: "KeyZ", metaKey: true });
    press(q("input[type=range]"), { key: "z", ctrlKey: true, shiftKey: true });
    expect(seen.map((e) => [e.key, e.metaKey, e.ctrlKey, e.shiftKey])).toEqual([
      ["z", true, false, false],
      ["z", false, true, true],
    ]);
    expect(seen[0].code).toBe("KeyZ");
    expect(original.defaultPrevented).toBe(true);
  });

  it("leaves text inputs, plain keys and Excalidraw's own targets alone", () => {
    press(q("input[type=text]"), { key: "z", metaKey: true });
    press(q("textarea"), { key: "z", ctrlKey: true });
    press(q("button"), { key: "Delete" });
    press(container.querySelector("canvas")!, { key: "z", metaKey: true });
    expect(seen).toHaveLength(0);
    expect(isTextTarget(q("input[type=range]"))).toBe(false);
  });

  it("returns focus to the container when a section's input drops it", () => {
    const input = q("input[type=text]");
    input.focus();
    input.blur();
    expect(document.activeElement).toBe(document.body);
    vi.runAllTimers();
    expect(document.activeElement).toBe(container);
  });

  it("focuses the container when a section is pressed while nothing has focus", () => {
    expect(document.activeElement).toBe(document.body);
    q("button").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.activeElement).toBe(container);
  });

  it("recovers shortcuts after a focused control is removed without a focusout", () => {
    q("button").focus();
    // jsdom (like Chrome) fires no focusout when a focused node is removed.
    q("button").remove();
    expect(document.activeElement).toBe(document.body);
    press(document.body, { key: "z", metaKey: true });
    expect(seen).toHaveLength(1);
    expect(document.activeElement).toBe(container);
    press(document.body, { key: "z", metaKey: true });
    expect(seen).toHaveLength(1);
  });
});
