import "../../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { Draft, ToolError, type El } from "../../agent/scene/draft";
import { createComponent, insertInstance } from "../../extensions/components/actions";
import { listComponents, tagOf } from "../../extensions/components/model";
import {
  entriesToExcalidrawLib,
  insertMyComponent,
  libraryItemToEntry,
  masterToEntry,
  renameComponent,
  topLeft,
} from "./libraryCodec";

function scene(): El[] {
  return convertToExcalidrawElements(
    [
      { type: "rectangle", id: "R", x: 100, y: 50, width: 200, height: 80, label: { text: "Hi" } },
      { type: "ellipse", id: "E", x: 320, y: 70, width: 40, height: 40 },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
}

function withComponent() {
  const draft = new Draft(scene());
  const made = createComponent(draft, ["R", "E"], "Card");
  return { draft, made };
}

describe("libraryCodec", () => {
  it("snapshots a master at the origin, keeping its tags", () => {
    const { draft, made } = withComponent();
    const entry = masterToEntry(draft.toArray(), undefined, made.componentId, 5);
    expect(entry).toMatchObject({ id: made.componentId, name: "Card", created: 5, updated: 5 });
    expect(entry.elements).toHaveLength(3);
    expect(topLeft(entry.elements)).toEqual({ x: 0, y: 0 });
    for (const el of entry.elements) expect(tagOf(el)?.role).toBe("master");
  });

  it("inserts master + instance into a document without the component (one draft)", () => {
    const { draft, made } = withComponent();
    const entry = masterToEntry(draft.toArray(), undefined, made.componentId);
    const other = new Draft([]);
    const res = insertMyComponent(other, entry, { x: 1000, y: 500 });
    expect(res.placedMaster).toBe(true);
    const comps = listComponents(other.toArray());
    expect(comps).toHaveLength(1);
    expect(comps[0].componentId).toBe(made.componentId);
    expect(comps[0].instances).toHaveLength(1);
    const master = other.toArray().filter((e) => comps[0].masterIds.includes(e.id));
    expect(topLeft(master)).toEqual({ x: 1000, y: 500 });
    // Fresh ids: none collide with the source document.
    const srcIds = new Set(draft.toArray().map((e) => e.id));
    expect(other.toArray().some((e) => srcIds.has(e.id))).toBe(false);
    // Bound text stays bound to its (renamed) container.
    const text = other.toArray().find((e) => e.type === "text" && comps[0].masterIds.includes(e.id));
    const container = other.get((text as { containerId: string }).containerId);
    expect(container?.boundElements?.some((b) => b.id === text!.id)).toBe(true);
  });

  it("inserts only an instance when the master is already in the document", () => {
    const { draft, made } = withComponent();
    const entry = masterToEntry(draft.toArray(), undefined, made.componentId);
    const res = insertMyComponent(draft, entry, { x: 0, y: 400 });
    expect(res.placedMaster).toBe(false);
    const [c] = listComponents(draft.toArray());
    expect(c.instances).toHaveLength(1);
  });

  it("rejects a damaged entry", () => {
    const { draft, made } = withComponent();
    const entry = masterToEntry(draft.toArray(), undefined, made.componentId);
    entry.elements = scene();
    expect(() => insertMyComponent(new Draft([]), entry, { x: 0, y: 0 })).toThrow(ToolError);
  });

  it("makes a library item into a component, and keeps an exported component as is", () => {
    const entry = libraryItemToEntry({ elements: scene(), name: "Badge" });
    expect(entry.name).toBe("Badge");
    expect(entry.elements.every((e) => tagOf(e)?.componentId === entry.id)).toBe(true);
    expect(topLeft(entry.elements)).toEqual({ x: 0, y: 0 });

    const lib = JSON.parse(entriesToExcalidrawLib([entry]));
    expect(lib).toMatchObject({ type: "excalidrawlib", version: 2 });
    const back = libraryItemToEntry(lib.libraryItems[0]);
    expect(back.id).toBe(entry.id);
    expect(back.name).toBe("Badge");
  });

  it("makes an instance-only library item into a new component", () => {
    const { draft, made } = withComponent();
    const inst = insertInstance(draft, made.componentId);
    const els = draft.toArray().filter((e) => inst.ids.includes(e.id));
    const entry = libraryItemToEntry({ elements: els, name: "Copy" });
    expect(entry.id).not.toBe(made.componentId);
    expect(entry.elements.every((e) => tagOf(e)?.role === "master")).toBe(true);
  });

  it("renames every member", () => {
    const { draft, made } = withComponent();
    insertInstance(draft, made.componentId);
    renameComponent(draft, made.componentId, "  Tile ");
    const [c] = listComponents(draft.toArray());
    expect(c.name).toBe("Tile");
    for (const el of draft.toArray()) expect(tagOf(el)?.name).toBe("Tile");
    expect(() => renameComponent(draft, made.componentId, " ")).toThrow(ToolError);
  });
});
