import "../../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { Draft, type El } from "../../agent/scene/draft";
import {
  createComponent,
  defineProperty,
  insertInstance,
  setProperties,
} from "../../extensions/components/actions";
import { parseChoices, propsView } from "./propsPanelSection";

function setup() {
  const draft = new Draft(
    convertToExcalidrawElements(
      [
        { type: "rectangle", id: "R", x: 0, y: 0, width: 200, height: 80, label: { text: "Hi" } },
        { type: "ellipse", id: "E", x: 220, y: 20, width: 40, height: 40 },
        { type: "diamond", id: "D", x: 0, y: 300, width: 40, height: 40 },
      ] as ExcalidrawElementSkeleton[],
      { regenerateIds: false },
    ),
  );
  const made = createComponent(draft, ["R", "E"], "Card");
  return { draft, made };
}

const pick = (els: El[], ids: string[]) => els.filter((e) => ids.includes(e.id));

describe("propsView", () => {
  it("describes a master's properties and bindable slots", () => {
    const { draft, made } = setup();
    defineProperty(draft, made.componentId, {
      name: "Title",
      type: "text",
      bindings: [{ elementId: "R" }],
    });
    const els = draft.toArray();
    const view = propsView(pick(els, made.ids), els);
    expect(view).toMatchObject({ kind: "master", name: "Card", componentId: made.componentId });
    expect(view?.kind === "master" && view.props.map((p) => p.name)).toEqual(["Title"]);
    // The bound label rides with its container, so it is not a separate slot.
    expect(view?.kind === "master" && view.slots).toEqual([
      { id: "R", label: "Rectangle" },
      { id: "E", label: "Ellipse" },
    ]);
  });

  it("hides for plain shapes, mixed selections and instances without properties", () => {
    const { draft, made } = setup();
    const inst = insertInstance(draft, made.componentId);
    const els = draft.toArray();
    expect(propsView(pick(els, ["D"]), els)).toBeNull();
    expect(propsView(pick(els, ["D", ...made.ids]), els)).toBeNull();
    expect(propsView(pick(els, inst.ids), els)).toBeNull();
  });

  it("lists own and nested property values on an outer instance", () => {
    const { draft, made } = setup();
    defineProperty(draft, made.componentId, {
      name: "Title",
      type: "text",
      bindings: [{ elementId: "R" }],
    });
    const inner = insertInstance(draft, made.componentId, { x: 0, y: 500 });
    const panel = createComponent(draft, [...inner.ids, "D"], "Panel");
    defineProperty(draft, panel.componentId, {
      name: "Show",
      type: "boolean",
      bindings: [{ elementId: "D" }],
    });
    const outer = insertInstance(draft, panel.componentId, { x: 600, y: 0 });
    setProperties(draft, outer.groupId, { Show: false });
    const els = draft.toArray();
    const view = propsView(pick(els, outer.ids), els);
    expect(view).toMatchObject({ kind: "instance", groupId: outer.groupId });
    if (view?.kind !== "instance") throw new Error("expected an instance view");
    expect(view.targets.map((t) => [t.title, t.nested === null, t.props[0].name])).toEqual([
      ["Panel", true, "Show"],
      ["Card", false, "Title"],
    ]);
    expect(Object.values(view.targets[0].values)).toEqual([false]);
  });
});

describe("parseChoices", () => {
  it("parses option=value pairs, dropping blanks and duplicates", () => {
    expect(
      parseChoices("Primary=#228be6, Danger = #e03131,,Primary=#000", "backgroundColor"),
    ).toEqual({
      options: ["Primary", "Danger"],
      map: { Primary: "#228be6", Danger: "#e03131" },
    });
    expect(parseChoices("Faint=30, Solid=100", "opacity").map).toEqual({ Faint: 30, Solid: 100 });
    expect(parseChoices("Yes, No", "text").map).toEqual({ Yes: "Yes", No: "No" });
  });
});
