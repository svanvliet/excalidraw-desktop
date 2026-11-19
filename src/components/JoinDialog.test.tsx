import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JoinDialog } from "./JoinDialog";
import { useSettingsStore, __resetSettingsForTests } from "../stores/settingsStore";

const LINK =
  "https://abc-4780.usw3.devtunnels.ms/#room=0123456789abcdef0123,AAAAAAAAAAAAAAAAAAAAAA";

function renderDialog() {
  const p = { open: true, onClose: vi.fn(), onJoin: vi.fn(), onOpenSettings: vi.fn() };
  render(<JoinDialog {...p} />);
  return p;
}

describe("JoinDialog", () => {
  beforeEach(() => {
    __resetSettingsForTests();
  });

  it("is gated by the collab toggle", () => {
    const p = renderDialog();
    expect(screen.getByTestId("join-disabled")).toBeInTheDocument();
    expect(screen.queryByTestId("join-link")).toBeNull();
    fireEvent.click(screen.getByTestId("join-open-settings"));
    expect(p.onOpenSettings).toHaveBeenCalled();
  });

  it("validates the pasted link before enabling Join", () => {
    useSettingsStore.setState({ collab: true });
    const p = renderDialog();
    const submit = screen.getByTestId("join-submit");
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId("join-link"), { target: { value: "https://x.test/" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/session link/);
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId("join-link"), { target: { value: LINK } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(submit);
    expect(p.onJoin).toHaveBeenCalledWith({
      publicBase: "https://abc-4780.usw3.devtunnels.ms",
      roomId: "0123456789abcdef0123",
      key: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(p.onClose).toHaveBeenCalled();
  });

  it("submits on Enter", () => {
    useSettingsStore.setState({ collab: true });
    const p = renderDialog();
    const input = screen.getByTestId("join-link");
    fireEvent.change(input, { target: { value: LINK } });
    fireEvent.submit(input.closest("form")!);
    expect(p.onJoin).toHaveBeenCalledTimes(1);
  });

  it("Escape and backdrop close", () => {
    const p = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("join-backdrop"));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });
});
