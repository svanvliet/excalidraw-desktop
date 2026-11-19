/**
 * Test-only helpers for the agent scene tools: jsdom stubs that let the real
 * `@excalidraw/excalidraw` helpers (convertToExcalidrawElements, newElementWith, restoreElements)
 * run, and a fake imperative API with a miniature model of Excalidraw's undo store.
 *
 * Import this module BEFORE anything that imports `@excalidraw/excalidraw`.
 */
import { vi } from "vitest";
import type { El } from "./draft";
import type { SceneApi } from "../sceneBridge";

// Text measurement + font loading don't exist in jsdom.
HTMLCanvasElement.prototype.getContext = function getContext() {
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "measureText"
          ? (s: string) => ({
              width: s.length * 8,
              actualBoundingBoxAscent: 10,
              actualBoundingBoxDescent: 2,
            })
          : () => ({}),
    },
  );
} as never;

class FakeFontFace {
  family = "";
  status = "loaded";
  load() {
    return Promise.resolve(this);
  }
}
(globalThis as Record<string, unknown>).FontFace ??= FakeFontFace;
if (!("fonts" in document) || !document.fonts) {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: () => {},
      delete: () => {},
      check: () => true,
      load: () => Promise.resolve([]),
      ready: Promise.resolve(),
      [Symbol.iterator]: function* () {},
    },
  });
}

type Capture = "IMMEDIATELY" | "NEVER" | "EVENTUALLY" | undefined;

/**
 * Minimal stand-in for ExcalidrawImperativeAPI. Its store mirrors 0.18.1 semantics: IMMEDIATELY
 * pushes (snapshot → next) as one undo entry, NEVER moves the snapshot silently, and elements
 * missing from `next` become tombstones in the snapshot.
 */
export class FakeApi implements SceneApi {
  elements: El[];
  snapshot: Map<string, El>;
  undoStack: Array<Map<string, { before: El | undefined; after: El | undefined }>> = [];
  calls: Array<{ captureUpdate: Capture; ids: string[] }> = [];
  selectedElementIds: Record<string, true> = {};
  /** Extra appState set through updateScene (background, grid, …). */
  appState: Record<string, unknown> = {};
  files: Record<string, unknown> = {};
  scrollToContent = vi.fn();
  addFiles = vi.fn();

  constructor(elements: El[] = []) {
    this.elements = elements;
    this.snapshot = new Map(elements.map((e) => [e.id, e]));
  }

  getSceneElementsIncludingDeleted = () => this.elements as never;
  getSceneElements = () => this.elements.filter((e) => !e.isDeleted) as never;
  getAppState = () =>
    ({
      selectedElementIds: this.selectedElementIds,
      scrollX: 0,
      scrollY: 0,
      width: 1000,
      height: 800,
      zoom: { value: 1 },
      ...this.appState,
    }) as never;
  getFiles = () => this.files as never;

  updateScene = ((data: {
    elements?: readonly El[];
    appState?: Record<string, unknown>;
    captureUpdate?: Capture;
  }) => {
    if (data.appState) {
      const { selectedElementIds, ...rest } = data.appState;
      if (selectedElementIds) this.selectedElementIds = selectedElementIds as Record<string, true>;
      Object.assign(this.appState, rest);
    }
    if (!data.elements) return;
    const next = new Map<string, El>();
    // Like createElementsSnapshot: omitted elements become tombstones via newElementWith.
    for (const [id, el] of this.snapshot) {
      next.set(id, { ...el, isDeleted: true, versionNonce: el.versionNonce + 1 } as El);
    }
    for (const el of data.elements) next.set(el.id, el);
    this.calls.push({ captureUpdate: data.captureUpdate, ids: data.elements.map((e) => e.id) });
    if (data.captureUpdate === "IMMEDIATELY") {
      const delta = new Map<string, { before: El | undefined; after: El | undefined }>();
      for (const [id, after] of next) {
        const before = this.snapshot.get(id);
        if (before?.versionNonce !== after.versionNonce) delta.set(id, { before, after });
      }
      if (delta.size) this.undoStack.push(delta);
      this.snapshot = next;
    } else if (data.captureUpdate === "NEVER") {
      this.snapshot = next;
    }
    this.elements = [...data.elements];
  }) as never;

  /** Apply the inverse of the latest undo entry (like Ctrl+Z). */
  undo(): void {
    const delta = this.undoStack.pop();
    if (!delta) throw new Error("nothing to undo");
    const byId = new Map(this.elements.map((e) => [e.id, e]));
    for (const [id, { before }] of delta) {
      if (before) byId.set(id, before);
      else {
        const cur = byId.get(id);
        if (cur) byId.set(id, { ...cur, isDeleted: true } as El);
      }
    }
    this.elements = [...byId.values()];
    this.snapshot = new Map(byId);
  }

  byId(id: string): El {
    const el = this.elements.find((e) => e.id === id);
    if (!el) throw new Error(`no element ${id}`);
    return el;
  }

  /** Simulate a user/collab edit committed outside the agent. */
  externalEdit(id: string, patch: Partial<El>): void {
    this.elements = this.elements.map((e) =>
      e.id === id
        ? ({ ...e, ...patch, version: e.version + 1, versionNonce: e.versionNonce + 1 } as El)
        : e,
    );
    this.snapshot = new Map(this.elements.map((e) => [e.id, e]));
  }
}
