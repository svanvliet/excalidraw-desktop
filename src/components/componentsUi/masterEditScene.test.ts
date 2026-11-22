import "../../agent/scene/testHarness";
import { describe, expect, it } from "vitest";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { Draft, type El } from "../../agent/scene/draft";
import { createComponent, insertInstance } from "../../extensions/components/actions";
import { demoteMaster } from "../../extensions/components/library";
import { listComponents, tagFor } from "../../extensions/components/model";
import {
  buildMasterEditScene,
  CTX_KEY,
  editedMaster,
  isContextCopy,
  masterChanged,
} from "./masterEditScene";

const VIEW = { scrollX: 0, scrollY: 0, zoom: 1, width: 1000, height: 800 };

/** A masterless "Card" (rectangle + text) with two instances, plus an unrelated ellipse. */
function drawing() {
  const draft = new Draft(
    convertToExcalidrawElements(
      [
        { type: "ellipse", id: "E", x: 600, y: 50, width: 80, height: 80 },
        { type: "rectangle", id: "R", x: 100, y: 100, width: 200, height: 100 },
        { type: "text", id: "T", x: 120, y: 120, text: "Hi" },
        { type: "ellipse", id: "FAR", x: 90000, y: 90000, width: 10, height: 10 },
      ] as ExcalidrawElementSkeleton[],
      { regenerateIds: false },
    ),
  );
  const made = createComponent(draft, ["R", "T"], "Card");
  const second = insertInstance(draft, made.componentId, { x: 400, y: 400 });
  demoteMaster(draft, made.masterGroupId);
  const els = draft.toArray();
  const info = listComponents(els)[0];
  const first = info.instances.find((i) => i.groupId !== second.groupId)!;
  return { els, cid: made.componentId, first, second };
}

const rectOf = (els: readonly El[]) =>
  els.find((e) => e.type === "rectangle" && !isContextCopy(e))!;

describe("buildMasterEditScene", () => {
  it("puts the master on the instance, with dimmed locked context in view", () => {
    const { els, cid, second } = drawing();
    const scene = buildMasterEditScene(els, {}, second.groupId, VIEW);
    expect(scene.name).toBe("Card");
    expect(scene.instanceCount).toBe(2);
    const instRect = rectOf(els.filter((e) => second.ids.includes(e.id)));
    const master = scene.elements.filter((e) => !isContextCopy(e));
    expect(master.every((e) => tagFor(e, cid)?.role === "master")).toBe(true);
    expect([rectOf(master).x, rectOf(master).y]).toEqual([instRect.x, instRect.y]);

    const ctx = scene.elements.filter(isContextCopy);
    // The other instance and the near ellipse; not the edited instance, not the far ellipse.
    expect(ctx).toHaveLength(els.length - second.ids.length - 1);
    for (const c of ctx) {
      expect(c.locked).toBe(true);
      expect(c.opacity).toBeLessThan(100);
      expect(c.customData).toEqual({ [CTX_KEY]: 1 });
      expect(els.some((e) => e.id === c.id)).toBe(false);
    }
  });

  it("centres the master on a resized instance", () => {
    const { els, second } = drawing();
    const scaled = els.map((e) =>
      second.ids.includes(e.id) && e.type === "rectangle" ? ({ ...e, width: 400 } as El) : e,
    );
    const scene = buildMasterEditScene(scaled, {}, second.groupId, VIEW);
    const r = rectOf(scaled.filter((e) => second.ids.includes(e.id)));
    const m = rectOf(scene.elements);
    expect(m.width).toBe(200);
    expect(m.x + m.width / 2).toBeCloseTo(r.x + r.width / 2, 0);
  });
});

describe("editedMaster", () => {
  it("drops context, moves the master back, and reports changes", () => {
    const { els, second } = drawing();
    const scene = buildMasterEditScene(els, {}, second.groupId, VIEW);
    expect(masterChanged(scene, scene.elements)).toBe(false);
    const overlay = scene.elements.map((e) =>
      isContextCopy(e)
        ? ({ ...e, x: e.x + 5, version: e.version + 1 } as El)
        : e.type === "rectangle"
          ? ({ ...e, width: 250, version: e.version + 1 } as El)
          : e,
    );
    expect(masterChanged(scene, overlay)).toBe(true);
    const out = editedMaster(scene, overlay);
    expect(out.some(isContextCopy)).toBe(false);
    expect(out).toHaveLength(scene.masterIds.length);
    expect(rectOf(out).x).toBe(rectOf(scene.elements).x - scene.offset.dx);
    expect(rectOf(out).width).toBe(250);
  });

  it("a duplicated master child becomes a new child, not a clash", () => {
    const { els, cid, second } = drawing();
    const scene = buildMasterEditScene(els, {}, second.groupId, VIEW);
    const rect = rectOf(scene.elements);
    const copy = { ...rect, id: "COPY", y: rect.y + 300 } as El;
    const out = editedMaster(scene, [...scene.elements, copy]);
    expect(
      tagFor(
        out.find((e) => e.id === rect.id),
        cid,
      )?.role,
    ).toBe("master");
    expect(
      tagFor(
        out.find((e) => e.id === "COPY"),
        cid,
      ),
    ).toBeNull();
  });
});
