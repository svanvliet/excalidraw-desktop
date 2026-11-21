// Line anchors (D-DX15) against the REAL Excalidraw 0.18.1 (Store/History) in jsdom: a pinned
// straight arrow end follows its shape's face midpoint through the reactor rule.
import "../../agent/scene/testHarness";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { anchorPoint, sideOf } from "../../lib/elbowAnchors";
import { absolutePoints, endAnchors, pinOf, snapPatches } from "../../lib/lineAnchors";
import { settleEnds } from "./pointer";
import { installComponents, uninstallComponents } from "../components/host";
import type { El } from "../reactor/reactor";

type Api = ExcalidrawImperativeAPI;

const g = globalThis as Record<string, unknown>;
g.Path2D ??= class {
  addPath() {}
};
g.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(document as unknown as { fonts: { has?: () => boolean } }).fonts.has ??= () => true;

const mounted: Api[] = [];
afterEach(() => {
  for (const api of mounted.splice(0)) uninstallComponents(api);
  cleanup();
});

function manualSchedule() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
      return () => {
        const i = queue.indexOf(cb);
        if (i >= 0) queue.splice(i, 1);
      };
    },
    frame: () => act(() => queue.splice(0).forEach((cb) => cb())),
  };
}

async function setup(elbowed = false) {
  const elements = convertToExcalidrawElements(
    [
      { type: "rectangle", id: "A", x: 0, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "B", x: 300, y: 100, width: 100, height: 60 },
      {
        type: "arrow",
        id: "a",
        x: 0,
        y: 0,
        start: { id: "A" },
        end: { id: "B" },
        ...(elbowed ? { elbowed: true } : {}),
      },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
  let api: Api | null = null;
  render(<Excalidraw excalidrawAPI={(a) => (api = a)} initialData={{ elements }} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  mounted.push(api!);
  const clock = manualSchedule();
  installComponents(api!, { schedule: clock.schedule });
  return { api: api as unknown as Api, clock };
}

const all = (api: Api) => api.getSceneElementsIncludingDeleted();
const get = (api: Api, id: string) => all(api).find((e) => e.id === id)! as El;
const endOf = (api: Api) => {
  const pts = absolutePoints(get(api, "a") as never);
  return pts[pts.length - 1];
};
const click = (label: "Undo" | "Redo") =>
  act(() => void fireEvent.click(document.querySelector(`[aria-label="${label}"]`)!));

function userEdit(api: Api, patches: Map<string, Record<string, unknown>>) {
  act(() =>
    api.updateScene({
      elements: all(api).map((e) => {
        const p = patches.get(e.id);
        return p ? { ...e, ...p, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e;
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    }),
  );
}

const pinEnd = (api: Api) =>
  userEdit(
    api,
    snapPatches(get(api, "a") as never, "end", { shape: get(api, "B"), anchor: "n" }, (id) =>
      get(api, id),
    ),
  );

const expectAt = (p: readonly number[], q: readonly number[]) => {
  expect(p[0]).toBeCloseTo(q[0], 0);
  expect(p[1]).toBeCloseTo(q[1], 0);
};

describe("line anchors (real Excalidraw)", () => {
  it("keeps a pinned end on its face midpoint through move, resize and rotate", async () => {
    const { api, clock } = await setup();
    pinEnd(api);
    clock.frame();
    expect(endAnchors(get(api, "a") as never).end).toBe("n");
    expectAt(endOf(api), anchorPoint("n", get(api, "B")));

    for (const patch of [{ x: 500, y: 300 }, { width: 240, height: 90 }, { angle: 0.6 }]) {
      userEdit(api, new Map([["B", patch]]));
      clock.frame();
      expectAt(endOf(api), anchorPoint("n", get(api, "B")));
      expect((get(api, "a") as unknown as { endBinding: unknown }).endBinding).toMatchObject({
        elementId: "B",
        gap: 5,
      });
    }
  });

  it("a shape move and its arrow re-snap undo as one step", async () => {
    const { api, clock } = await setup();
    pinEnd(api);
    clock.frame();
    const before = endOf(api);
    userEdit(api, new Map([["B", { x: 600 }]]));
    clock.frame();
    expect(endOf(api)[0]).toBeGreaterThan(before[0] + 100);
    click("Undo");
    clock.frame();
    expect(get(api, "B").x).toBe(300);
    expectAt(endOf(api), before);
  });

  it("stops following once the end is unbound", async () => {
    const { api, clock } = await setup();
    pinEnd(api);
    clock.frame();
    userEdit(api, new Map([["a", { endBinding: null }]]));
    clock.frame();
    const free = endOf(api);
    userEdit(api, new Map([["B", { x: 700 }]]));
    clock.frame();
    expectAt(endOf(api), free);
    expect(endAnchors(get(api, "a") as never).end).toBeNull();
  });

  describe("settleEnds (pointer-up)", () => {
    /** Drop the arrow's end at `p` (as if the user had dragged it there), then settle it. */
    function dropEnd(api: Api, p: [number, number], bypass = false) {
      const a = get(api, "a") as never as { x: number; y: number; points: number[][] };
      const points = a.points.map((q, i) =>
        i === a.points.length - 1 ? [p[0] - a.x, p[1] - a.y] : q,
      );
      userEdit(api, new Map([["a", { points }]]));
      act(() => {
        settleEnds(get(api, "a"), ["end"], all(api), 1, bypass);
      });
    }

    it("snaps, binds and pins an end dropped near a face midpoint", async () => {
      const { api, clock } = await setup();
      dropEnd(api, [345, 96]); // B's north midpoint is (350, 100)
      clock.frame();
      expectAt(endOf(api), anchorPoint("n", get(api, "B")));
      expect(pinOf(get(api, "a")).end).toEqual({ id: "B", anchor: "n" });
      expect(get(api, "B").boundElements?.some((b) => b.id === "a")).toBe(true);
    });

    it("snaps to the centre too, and leaves a far or bypassed drop free", async () => {
      const { api, clock } = await setup();
      dropEnd(api, [352, 128]);
      clock.frame();
      expect(endAnchors(get(api, "a") as never).end).toBe("center");

      dropEnd(api, [330, 120]);
      clock.frame();
      expect(pinOf(get(api, "a")).end).toBeUndefined();

      dropEnd(api, [345, 96], true);
      clock.frame();
      expect(pinOf(get(api, "a")).end).toBeUndefined();
    });

    it("sets an elbow arrow's fixedPoint instead of a pin", async () => {
      const { api } = await setup(true);
      dropEnd(api, [404, 131]); // B's east midpoint is (400, 130)
      const a = get(api, "a") as never as { endBinding: { fixedPoint: [number, number] } };
      expect(sideOf(a.endBinding.fixedPoint)).toBe("e");
      expect(pinOf(get(api, "a")).end).toBeUndefined();
      expectAt(endOf(api), anchorPoint("e", get(api, "B")));
    });
  });
});
