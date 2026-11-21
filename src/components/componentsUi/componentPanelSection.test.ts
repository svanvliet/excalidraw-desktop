import "../../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { Draft, type El } from "../../agent/scene/draft";
import { createComponent, insertInstance, setOverrides } from "../../extensions/components/actions";
import { tagOf } from "../../extensions/components/model";
import { componentView } from "./componentPanelSection";
import { insertMyComponent, masterToEntry } from "./libraryCodec";

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
  const inst = insertInstance(draft, made.componentId);
  return { draft, made, inst };
}

const pick = (els: El[], ids: string[]) => els.filter((e) => ids.includes(e.id));

describe("componentView", () => {
  it("offers Create for plain shapes and hides for mixed selections", () => {
    const { draft, made } = setup();
    const els = draft.toArray();
    expect(componentView(pick(els, ["D"]), els)).toEqual({ kind: "create", count: 1 });
    expect(componentView(pick(els, ["D", ...made.ids]), els)).toBeNull();
  });

  it("describes a master with its instance count", () => {
    const { draft, made } = setup();
    const els = draft.toArray();
    expect(componentView(pick(els, made.ids), els)).toMatchObject({
      kind: "master",
      name: "Card",
      instances: 1,
      componentId: made.componentId,
    });
  });

  it("lists an instance's overridden slots", () => {
    const { draft, inst } = setup();
    const text = draft.toArray().find((e) => inst.ids.includes(e.id) && e.type === "text")!;
    setOverrides(draft, inst.groupId, [{ elementId: text.id, values: { text: "Bye" } }]);
    const els = draft.toArray();
    const view = componentView(pick(els, inst.ids), els);
    expect(view).toMatchObject({ kind: "instance", hasMaster: true, libraryBacked: false });
    expect(view?.kind === "instance" && view.overrides).toEqual([
      { slot: tagOf(text)!.slot, label: expect.stringContaining("Text"), keys: ["text"] },
    ]);
  });

  it("marks a library-backed instance without a master", () => {
    const { draft, made } = setup();
    const entry = masterToEntry(draft.toArray(), undefined, made.componentId);
    const other = new Draft([]);
    const res = insertMyComponent(other, entry, { x: 0, y: 0 }, { libraryBacked: true });
    const els = other.toArray().filter((e) => !e.isDeleted);
    const view = componentView(pick(els, res.instance.ids), els);
    expect(view).toMatchObject({
      kind: "instance",
      hasMaster: false,
      libraryBacked: true,
      libraryId: made.componentId,
    });
  });
});
