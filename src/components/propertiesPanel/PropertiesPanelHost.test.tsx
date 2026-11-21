import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { FakeApi } from "../../agent/scene/testHarness";
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
): AnyPanelSection => ({
  id,
  slot,
  testId: id,
  view: ({ selected }) => {
    const types = selected.map((s) => s.type);
    return when(types) ? { n: selected.length } : null;
  },
  Component: ({ view }: { view: { n: number } }) => (
    <span>
      {id}:{view.n}
    </span>
  ),
});

const SECTIONS = [
  section("t1", "top", () => true),
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

describe("PropertiesPanelHost", () => {
  it("places top sections after the first slot and bottom ones at the end, in order", async () => {
    menu.append(nativePanel());
    renderHost();
    expect(screen.queryByTestId("t1-native")).toBeNull();

    api.select("r", "e");
    await screen.findByText("t1:2");
    expect(order()).toEqual([
      "first",
      "t1-native",
      "t2-native",
      "mid",
      "last",
      "b1-native",
      "b2-native",
    ]);

    api.select("e");
    await waitFor(() => expect(screen.queryByText("t2:2")).toBeNull());
    expect(order()).toEqual(["first", "t1-native", "mid", "last", "b2-native"]);
    expect(screen.getByText("b2:1")).toBeInTheDocument();
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

    act(() => menu.append(nativePanel()));
    await screen.findByTestId("t1-native");
    expect(screen.queryByTestId("props-dock")).toBeNull();

    menu.replaceChildren(nativePanel());
    await waitFor(() => expect(order()).toContain("b2-native"));
    expect(order()).toEqual([
      "first",
      "t1-native",
      "t2-native",
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
