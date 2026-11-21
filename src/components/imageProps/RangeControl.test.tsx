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

  it("commits the drafted value once on release", () => {
    const { slider, onCommit } = renderIn(() => {});
    fireEvent.change(slider, { target: { value: "40" } });
    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(40);
  });
});
