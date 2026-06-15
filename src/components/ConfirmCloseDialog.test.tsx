import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmCloseDialog } from "./ConfirmCloseDialog";

function setup(open = true) {
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmCloseDialog
      open={open}
      tabLabel="diagram.excalidraw"
      onSave={onSave}
      onDiscard={onDiscard}
      onCancel={onCancel}
    />,
  );
  return { onSave, onDiscard, onCancel };
}

describe("ConfirmCloseDialog", () => {
  it("renders nothing when open is false", () => {
    setup(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders all three buttons and the tab label when open", () => {
    setup();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/diagram\.excalidraw has unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /don.?t save/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("focuses the Save button when opened", () => {
    setup();
    expect(screen.getByRole("button", { name: /^save$/i })).toHaveFocus();
  });

  it("invokes the matching callback for each button", () => {
    const { onSave, onDiscard, onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    fireEvent.click(screen.getByRole("button", { name: /don.?t save/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels", () => {
    const { onCancel } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop cancels but clicking the modal body does not", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
    // Find the backdrop — it's the parent of the dialog
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
