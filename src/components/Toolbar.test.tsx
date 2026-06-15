import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";
import { Toolbar } from "./Toolbar";

function setup(override: Partial<ComponentProps<typeof Toolbar>> = {}) {
  const props: ComponentProps<typeof Toolbar> = {
    documentPath: null,
    dirty: false,
    onOpen: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    ...override,
  };
  render(<Toolbar {...props} />);
  return props;
}

describe("Toolbar", () => {
  it("shows 'Untitled' when no file path is set", () => {
    setup();
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  it("shows just the basename of the document path", () => {
    setup({ documentPath: "/Users/me/projects/diagram.excalidraw" });
    expect(screen.getByText("diagram.excalidraw")).toBeInTheDocument();
  });

  it("renders a dirty marker only when dirty is true", () => {
    const { rerender } = render(
      <Toolbar
        documentPath="/p/x.excalidraw"
        dirty={false}
        onOpen={() => {}}
        onSave={() => {}}
        onSaveAs={() => {}}
      />,
    );
    expect(screen.queryByText("•")).not.toBeInTheDocument();
    rerender(
      <Toolbar
        documentPath="/p/x.excalidraw"
        dirty
        onOpen={() => {}}
        onSave={() => {}}
        onSaveAs={() => {}}
      />,
    );
    expect(screen.getByText("•")).toBeInTheDocument();
  });

  it("disables Save when the file is already saved and clean", () => {
    setup({ documentPath: "/p/x.excalidraw", dirty: false });
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("enables Save when the document is dirty", () => {
    setup({ documentPath: "/p/x.excalidraw", dirty: true });
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
  });

  it("enables Save when the document has never been saved", () => {
    setup({ documentPath: null, dirty: false });
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
  });

  it("wires button clicks to the corresponding callbacks", () => {
    const props = setup({ documentPath: null });
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    fireEvent.click(screen.getByRole("button", { name: /save as/i }));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSaveAs).toHaveBeenCalledTimes(1);
  });
});
