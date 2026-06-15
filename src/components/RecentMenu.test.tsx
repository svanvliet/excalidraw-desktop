import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecentMenu } from "./RecentMenu";

describe("RecentMenu", () => {
  it("disables the trigger when there are no recent paths", () => {
    render(<RecentMenu paths={[]} onOpen={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByRole("button", { name: /recent/i })).toBeDisabled();
  });

  it("shows the list when toggled and hides it again on second click", () => {
    render(<RecentMenu paths={["/a/foo.excalidraw"]} onOpen={vi.fn()} onClear={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /recent/i });
    fireEvent.click(trigger);
    expect(screen.getByTestId("recent-menu-list")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId("recent-menu-list")).not.toBeInTheDocument();
  });

  it("invokes onOpen with the selected path and closes the menu", () => {
    const onOpen = vi.fn();
    render(
      <RecentMenu
        paths={["/a/foo.excalidraw", "/b/bar.excalidraw"]}
        onOpen={onOpen}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /recent/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /bar\.excalidraw/i }));
    expect(onOpen).toHaveBeenCalledWith("/b/bar.excalidraw");
    expect(screen.queryByTestId("recent-menu-list")).not.toBeInTheDocument();
  });

  it("invokes onClear when Clear Recent is selected", () => {
    const onClear = vi.fn();
    render(<RecentMenu paths={["/a/foo.excalidraw"]} onOpen={vi.fn()} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: /recent/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /clear recent/i }));
    expect(onClear).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    render(<RecentMenu paths={["/a/foo.excalidraw"]} onOpen={vi.fn()} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /recent/i }));
    expect(screen.getByTestId("recent-menu-list")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("recent-menu-list")).not.toBeInTheDocument();
  });
});
