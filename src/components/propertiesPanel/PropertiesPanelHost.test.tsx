import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { FakeApi } from "../../agent/scene/testHarness";
import { usePanelStripStore } from "../../stores/panelStripStore";
import { PropertiesPanelHost } from "./PropertiesPanelHost";
import type { AnyPanelSection, PanelApi } from "./panel";

class HostApi extends FakeApi {
  listeners = new Set<() => void>();
  onChange = ((cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }) as never;
  select(...ids: string[]) {
    this.selectedElementIds = Object.fromEntries(ids.map((id) => [id, true]));
    act(() => this.listeners.forEach((cb) => cb()));
  }
}

const el = (id: string, type: string) =>
  ({
    id,
    type,
    isDeleted: false,
    groupIds: [],
    boundElements: null,
  }) as unknown as ExcalidrawElement;

const section = (
  id: string,
  slot: "top" | "bottom",
  when: (types: string[]) => boolean,
  extra: Partial<AnyPanelSection> = {},
): AnyPanelSection => ({
  id,
  slot,
  testId: id,
  title: id.toUpperCase(),
  icon: () => <svg />,
  summary: ({ n }: { n: number }) => `${id} of ${n}`,
  view: ({ selected }) => {
    const types = selected.map((s) => s.type);
    return when(types) ? { n: selected.length } : null;
  },
  Component: ({ view }: { view: { n: number } }) => (
    <span>
      {id}:{view.n}
    </span>
  ),
  ...extra,
});

const run = vi.fn();
const SECTIONS = [
  section("t1", "top", () => true, {
    primary: ({ n }: { n: number }) => (n > 1 ? { label: "Go", run } : null),
  }),
  section("b1", "bottom", (t) => t.includes("rectangle")),
  section("t2", "top", (t) => t.includes("rectangle")),
  section("b2", "bottom", () => true),
];

function nativePanel(): HTMLElement {
  const column = document.createElement("div");
  column.className = "panelColumn";
  column.innerHTML = `<div data-testid="first"></div><fieldset data-testid="mid"></fieldset><div data-testid="last"></div>`;
  return column;
}

let api: HostApi;
let wrapper: HTMLDivElement;
let menu: HTMLElement;
beforeEach(() => {
  api = new HostApi([el("r", "rectangle"), el("e", "ellipse")] as never);
  wrapper = document.createElement("div");
  wrapper.innerHTML = `<div class="excalidraw"><div class="App-menu__left"></div></div>`;
  menu = wrapper.querySelector(".App-menu__left")!;
  document.body.append(wrapper);
  usePanelStripStore.setState({ open: null });
  run.mockReset();
});
afterEach(() => wrapper.remove());

const order = () =>
  Array.from(menu.querySelector(".panelColumn")!.children).map(
    (c) => (c as HTMLElement).dataset.testid,
  );

const renderHost = () =>
  render(
    <PropertiesPanelHost
      api={api as unknown as PanelApi}
      container={{ current: wrapper }}
      sections={SECTIONS}
    />,
  );

const toggle = (id: string) => fireEvent.click(screen.getByTestId(`${id}-toggle`));

describe("PropertiesPanelHost", () => {
  it("puts the strip rows first and bottom sections at the end, in order", async () => {
    menu.append(nativePanel());
    renderHost();
    expect(screen.queryByTestId("t1-native")).toBeNull();

    api.select("r", "e");
    await screen.findByTestId("t1-native");
    expect(order()).toEqual([
      "t1-native",
      "t2-native",
      "first",
      "mid",
      "last",
      "b1-native",
      "b2-native",
    ]);
    const last = (id: string) =>
      screen.getByTestId(id).classList.contains("props-strip__row--last");
    expect([last("t1-native"), last("t2-native")]).toEqual([false, true]);
    expect(screen.getByText("t2 of 2")).toBeInTheDocument();
    // Rows start collapsed; bottom sections render their body as before.
    expect(screen.queryByText("t1:2")).toBeNull();
    expect(screen.getByText("b2:2")).toBeInTheDocument();

    api.select("e");
    await waitFor(() => expect(screen.queryByTestId("t2-native")).toBeNull());
    expect(order()).toEqual(["t1-native", "first", "mid", "last", "b2-native"]);
    expect(last("t1-native")).toBe(true);
  });

  it("opens one row at a time and remembers it across selections", async () => {
    menu.append(nativePanel());
    renderHost();
    api.select("r", "e");
    await screen.findByTestId("t1-native");

    toggle("t1");
    expect(screen.getByText("t1:2")).toBeInTheDocument();
    expect(screen.getByTestId("t1-toggle")).toHaveAttribute("aria-expanded", "true");

    toggle("t2");
    expect(screen.queryByText("t1:2")).toBeNull();
    expect(screen.getByText("t2:2")).toBeInTheDocument();
    expect(screen.getByTestId("t1-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(usePanelStripStore.getState().open).toBe("t2");

    api.select("e");
    await waitFor(() => expect(screen.queryByTestId("t2-native")).toBeNull());
    expect(screen.queryByText("t1:1")).toBeNull();
    api.select("r");
    expect(await screen.findByText("t2:1")).toBeInTheDocument();

    toggle("t2");
    expect(screen.queryByText("t2:1")).toBeNull();
    expect(usePanelStripStore.getState().open).toBeNull();
  });

  it("runs a row's primary action without opening it", async () => {
    menu.append(nativePanel());
    renderHost();
    api.select("r");
    await screen.findByTestId("t1-native");
    expect(screen.queryByTestId("t1-primary")).toBeNull();

    api.select("r", "e");
    fireEvent.click(await screen.findByTestId("t1-primary"));
    expect(run).toHaveBeenCalledWith(api);
    expect(screen.queryByText("t1:2")).toBeNull();
  });

  it("renders a body-less row without a chevron or expanded state", async () => {
    menu.append(nativePanel());
    render(
      <PropertiesPanelHost
        api={api as unknown as PanelApi}
        container={{ current: wrapper }}
        sections={[section("t3", "top", () => true, { Component: undefined })]}
      />,
    );
    api.select("r");
    const btn = await screen.findByTestId("t3-toggle");
    expect(btn).not.toHaveAttribute("aria-expanded");
    expect(btn.querySelector(".props-strip__chevron")).toBeNull();
    fireEvent.click(btn);
    expect(usePanelStripStore.getState().open).toBeNull();
  });

  it("re-attaches after a remount and docks when there is no panel", async () => {
    renderHost();
    api.select("r");
    const dock = await screen.findByTestId("props-dock");
    expect(Array.from(dock.children).map((c) => (c as HTMLElement).dataset.testid)).toEqual([
      "t1-dock",
      "t2-dock",
      "b1-dock",
      "b2-dock",
    ]);
    expect(screen.getByTestId("t2-dock")).toHaveClass("props-strip__row--last");

    act(() => menu.append(nativePanel()));
    await screen.findByTestId("t1-native");
    expect(screen.queryByTestId("props-dock")).toBeNull();

    menu.replaceChildren(nativePanel());
    await waitFor(() => expect(order()).toContain("b2-native"));
    expect(order()).toEqual([
      "t1-native",
      "t2-native",
      "first",
      "mid",
      "last",
      "b1-native",
      "b2-native",
    ]);
  });

  it("hides everything mid-gesture", async () => {
    menu.append(nativePanel());
    renderHost();
    api.select("r");
    await screen.findByTestId("b2-native");
    api.appState.selectedElementsAreBeingDragged = true;
    api.select("r");
    await waitFor(() => expect(screen.queryByTestId("b2-native")).toBeNull());
    expect(order()).toEqual(["first", "mid", "last"]);
  });
});
