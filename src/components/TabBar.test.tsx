import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar } from "./TabBar";
import type { Tab } from "../stores/tabsStore";

function makeTab(over: Partial<Tab> = {}): Tab {
  return { id: "t1", path: null, initialData: null, dirty: false, ...over };
}

describe("TabBar", () => {
  it("renders 'Untitled' for tabs without a path", () => {
    render(
      <TabBar
        tabs={[makeTab()]}
        activeTabId="t1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  it("shows the file basename and a dirty marker when applicable", () => {
    render(
      <TabBar
        tabs={[makeTab({ path: "/Users/me/diagram.excalidraw", dirty: true })]}
        activeTabId="t1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getByText("diagram.excalidraw")).toBeInTheDocument();
    expect(screen.getByLabelText(/unsaved changes/i)).toBeInTheDocument();
  });

  it("marks the active tab with aria-selected", () => {
    render(
      <TabBar
        tabs={[makeTab({ id: "a" }), makeTab({ id: "b" })]}
        activeTabId="b"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  });

  it("fires onSelect when a tab is clicked", () => {
    const onSelect = vi.fn();
    render(
      <TabBar
        tabs={[makeTab({ id: "a" }), makeTab({ id: "b" })]}
        activeTabId="a"
        onSelect={onSelect}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("fires onClose when the × button is clicked, and not onSelect", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TabBar
        tabs={[makeTab({ id: "a", path: "/p/x.excalidraw" })]}
        activeTabId="a"
        onSelect={onSelect}
        onClose={onClose}
        onNew={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText(/close x.excalidraw/i));
    expect(onClose).toHaveBeenCalledWith("a");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("middle-click on a tab closes it", () => {
    const onClose = vi.fn();
    render(
      <TabBar
        tabs={[makeTab({ id: "a", path: "/p/x.excalidraw" })]}
        activeTabId="a"
        onSelect={() => {}}
        onClose={onClose}
        onNew={() => {}}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("tab"), { button: 1 });
    expect(onClose).toHaveBeenCalledWith("a");
  });

  it("fires onNew when the + button is clicked", () => {
    const onNew = vi.fn();
    render(
      <TabBar
        tabs={[makeTab()]}
        activeTabId="t1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={onNew}
      />,
    );
    fireEvent.click(screen.getByLabelText(/new tab/i));
    expect(onNew).toHaveBeenCalled();
  });
});
