import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LayoutMenu } from "./LayoutMenu";
import spec from "../layout/commands.json";

describe("LayoutMenu", () => {
  it("lists the native Layout menu's commands in order", () => {
    render(<LayoutMenu onRun={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Layout" }));
    const labels = screen
      .getAllByRole("menuitem")
      .map((b) => b.querySelector(".popover__item-name")!.textContent);
    expect(labels).toEqual(spec.flatMap((e) => ("label" in e ? [e.label] : [])));
    expect(screen.getAllByRole("separator")).toHaveLength(
      spec.filter((e) => "separator" in e).length,
    );
  });

  it("runs the chosen command and closes", () => {
    const onRun = vi.fn();
    render(<LayoutMenu onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Layout" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Tidy Arrows$/ }));
    expect(onRun).toHaveBeenCalledWith("excalidraw:layout:tidyArrows");
    expect(screen.queryByTestId("layout-menu-list")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<LayoutMenu onRun={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Layout" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("layout-menu-list")).not.toBeInTheDocument();
  });
});
