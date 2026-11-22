// Property-fed text in instances against the REAL Excalidraw 0.18.1 (FR-56/FR-64): text is
// re-measured with the real font once it loads, and fixed-width text wraps to its box.
import "../../agent/scene/testHarness";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  convertToExcalidrawElements,
  Excalidraw,
  setCustomTextMetricsProvider,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { El } from "../reactor/reactor";
import { createComponent, defineProperty, insertInstance, setProperties } from "./actions";
import {
  demoteMastersIn,
  installComponents,
  runComponentCommand,
  uninstallComponents,
} from "./host";
import { groupOf, tagOf } from "./model";
import { clearTextCache } from "./text";

type Api = ExcalidrawImperativeAPI;
type TextEl = ExcalidrawTextElement;

const g = globalThis as Record<string, unknown>;
g.Path2D ??= class {
  addPath() {}
};
g.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * A FontFaceSet whose Excalifont face is registered but only "loads" when the test says so.
 * Until then text measures with the narrower fallback face, like a browser before the woff2
 * arrives.
 */
const fonts = Object.assign(new EventTarget(), {
  loaded: false,
  add: () => {},
  delete: () => {},
  has: () => true,
  check: () => fonts.loaded,
  load: () => Promise.resolve([]),
  ready: Promise.resolve(),
  *[Symbol.iterator]() {
    yield { family: "Excalifont", status: fonts.loaded ? "loaded" : "unloaded" };
  },
});
Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
const NARROW = 8;
const WIDE = 10;
setCustomTextMetricsProvider({
  getLineWidth: (text) => text.length * (fonts.loaded ? WIDE : NARROW),
});

const mounted: Api[] = [];
afterEach(() => {
  for (const api of mounted.splice(0)) uninstallComponents(api);
  cleanup();
  fonts.loaded = false;
  clearTextCache();
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

async function mount(elements: readonly El[]) {
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

function run<T>(api: Api, fn: Parameters<typeof runComponentCommand<T>>[1]): T {
  let out: T | null = null;
  act(() => {
    out = runComponentCommand(api, fn);
  });
  return out!;
}

const all = (api: Api) => api.getSceneElementsIncludingDeleted();
const child = (api: Api, group: string, slot: string) =>
  all(api).find((e) => {
    const t = tagOf(e);
    return !e.isDeleted && t?.role === "instance" && groupOf(e, t) === group && t.slot === slot;
  }) as TextEl;

/** A card: rectangle "R" with a left-aligned name "N" and a centred title "T" (Excalifont). */
function card(extra: Partial<Record<"N" | "T", Record<string, unknown>>> = {}): El[] {
  return convertToExcalidrawElements(
    [
      { type: "rectangle", id: "R", x: 0, y: 0, width: 240, height: 100 },
      { type: "text", id: "N", x: 10, y: 10, text: "Name", fontFamily: 5, fontSize: 20 },
      {
        type: "text",
        id: "T",
        x: 80,
        y: 50,
        text: "Title",
        fontFamily: 5,
        fontSize: 20,
        textAlign: "center",
      },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  ).map((e) => (extra[e.id as "N" | "T"] ? ({ ...e, ...extra[e.id as "N" | "T"] } as El) : e));
}

function withTextProps(api: Api) {
  const created = run(api, (d) => createComponent(d, ["R", "N", "T"], "Person"));
  const cid = created.componentId;
  run(api, (d) => {
    defineProperty(d, cid, {
      id: "name",
      name: "Name",
      type: "text",
      bindings: [{ elementId: "N" }],
    });
    defineProperty(d, cid, {
      id: "title",
      name: "Title",
      type: "text",
      bindings: [{ elementId: "T" }],
    });
  });
  return created;
}

const loadFonts = (clock: ReturnType<typeof manualSchedule>) => {
  fonts.loaded = true;
  act(() => void fonts.dispatchEvent(new Event("loadingdone")));
  clock.frame();
};

describe("property text measured before the font loaded", () => {
  it("is re-measured once fonts load: left keeps x, centred keeps its centre", async () => {
    const { api, clock } = await mount(card());
    const { componentId: cid } = withTextProps(api);
    const inst = run(api, (d) => insertInstance(d, cid, { x: 0, y: 300 }));
    run(api, (d) =>
      setProperties(d, inst.groupId, { name: "Casey Jacobs", title: "Chief of Staff" }),
    );
    clock.frame();
    const name0 = child(api, inst.groupId, "N");
    const title0 = child(api, inst.groupId, "T");
    expect(name0.width).toBe(12 * NARROW);
    const titleCentre = title0.x + title0.width / 2;

    loadFonts(clock);
    const name = child(api, inst.groupId, "N");
    const title = child(api, inst.groupId, "T");
    expect(name.width).toBe(12 * WIDE);
    expect(name.x).toBe(name0.x);
    expect(title.width).toBe(14 * WIDE);
    expect(title.x + title.width / 2).toBeCloseTo(titleCentre);
    expect(name.text).toBe("Casey Jacobs");
  });

  it("covers a legacy file whose on-canvas master is demoted on load", async () => {
    fonts.loaded = true;
    const first = await mount(card());
    const { componentId: cid } = withTextProps(first.api);
    const inst = run(first.api, (d) => insertInstance(d, cid, { x: 0, y: 300 }));
    run(first.api, (d) => setProperties(d, inst.groupId, { name: "Casey Jacobs" }));
    first.clock.frame();
    const saved = all(first.api).map((e) => ({ ...e }));
    expect(child(first.api, inst.groupId, "N").width).toBe(12 * WIDE);
    uninstallComponents(first.api);
    cleanup();
    clearTextCache();

    // Reopen with a fresh webview: the fonts aren't loaded when the file is migrated.
    fonts.loaded = false;
    const { api, clock } = await mount(demoteMastersIn(saved));
    expect(child(api, inst.groupId, "N").width).toBe(12 * NARROW);
    loadFonts(clock);
    expect(child(api, inst.groupId, "N").width).toBe(12 * WIDE);
  });
});

describe("fixed-width (autoResize: false) property text", () => {
  it("wraps to the slot's width and grows its height", async () => {
    fonts.loaded = true;
    const { api, clock } = await mount(card({ T: { autoResize: false, width: 100 } }));
    const { componentId: cid } = withTextProps(api);
    const inst = run(api, (d) => insertInstance(d, cid, { x: 0, y: 300 }));
    const before = child(api, inst.groupId, "T");
    run(api, (d) => setProperties(d, inst.groupId, { title: "VP, Xbox Services and Operations" }));
    clock.frame();
    const t = child(api, inst.groupId, "T");
    expect(t.width).toBe(100);
    expect(t.originalText).toBe("VP, Xbox Services and Operations");
    expect(t.text.split("\n").length).toBeGreaterThan(1);
    expect(t.height).toBeGreaterThan(before.height);
    for (const line of t.text.split("\n")) expect(line.length * WIDE).toBeLessThanOrEqual(100);
  });
});
