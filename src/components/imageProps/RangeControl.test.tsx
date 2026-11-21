import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RangeControl } from "./RangeControl";

describe("RangeControl", () => {
  const renderIn = (onKey: (e: KeyboardEvent) => void, onCommit = vi.fn()) => {
    const host = document.createElement("div");
    host.className = "excalidraw excalidraw-container";
    host.addEventListener("keydown", onKey);
    document.body.appendChild(host);
    render(
      <RangeControl
        label="Amount"
        value={null}
        fallback={0}
        min={0}
        max={100}
        step={5}
        testId="amount"
        onCommit={onCommit}
      />,
      { container: host },
    );
    return { slider: screen.getByTestId("amount"), onCommit };
  };

  it("forwards Ctrl/Cmd shortcuts to Excalidraw's container, but keeps arrow keys", () => {
    const seen: string[] = [];
    const { slider } = renderIn((e) => {
      if (e.target === e.currentTarget) seen.push(`${e.ctrlKey ? "ctrl+" : ""}${e.key}`);
    });
    fireEvent.keyDown(slider, { key: "z", code: "KeyZ", ctrlKey: true });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "a" });
    expect(seen).toEqual(["ctrl+z"]);
  });

  it("commits the drafted value once on release", () => {
    const { slider, onCommit } = renderIn(() => {});
    fireEvent.change(slider, { target: { value: "40" } });
    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(40);
  });
});
