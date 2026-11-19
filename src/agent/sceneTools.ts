/**
 * The canvas tools of src/agent/tools.json, executed against a tab's live Excalidraw API
 * (docs/ai-integration.md § Agent tool set). Pure webview code: the Rust MCP server forwards
 * each `tools/call` as an `agent://tool-call` event and toolExecutor.ts routes it here.
 *
 * Read tools return compact JSON plus the scene `revision`. Edit tools build a `Draft`, apply
 * the change synchronously, and commit once (scene/turns.ts decides the undo grouping) — so a
 * failed edit or `apply_ops` batch never leaves a half-applied scene.
 */
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  FONT_FAMILY,
  getVisibleSceneBounds,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { bytesToBase64 } from "../lib/fileFormat";
import {
  type Box,
  boundsOf,
  Draft,
  type El,
  intersects,
  isLinear,
  isText,
  moveElements,
  newId,
  placeBoundText,
  rerouteAround,
  revisionOf,
  routeArrow,
  ToolError,
  unionBounds,
  BINDABLE_TYPES,
} from "./scene/draft";
import { isFoldedText, rowOf } from "./scene/summary";
import { commitDraft } from "./scene/turns";
import { getActiveSceneTabId, getSceneTab, listSceneTabs, type SceneTab } from "./sceneBridge";
import { CANVAS_TOOLS, type ToolContent } from "./types";

export { ToolError } from "./scene/draft";
export {
  beginTurn,
  endTurn,
  revertTurn,
  canRevertTurn,
  type RevertTurnResult,
} from "./scene/turns";

type Args = Record<string, unknown>;

const READ_ONLY = new Map(CANVAS_TOOLS.map((t) => [t.name, t.readOnly]));
const EDIT_TOOLS = new Set([
  "add_elements",
  "update_elements",
  "delete_elements",
  "connect",
  "add_mermaid",
  "arrange",
  "move_elements",
  "duplicate_elements",
]);

// --- arg helpers -------------------------------------------------------------

function json(value: unknown): ToolContent[] {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string`);
  return v;
}

function optNum(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new ToolError(`"${key}" must be a number`);
  return v;
}

function reqArray(args: Args, key: string): unknown[] {
  const v = args[key];
  if (!Array.isArray(v) || !v.length) throw new ToolError(`"${key}" must be a non-empty array`);
  return v;
}

function strArray(args: Args, key: string, required = false): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ToolError(`"${key}" must be an array of element id strings`);
  }
  if (required && !v.length) throw new ToolError(`"${key}" must not be empty`);
  return v as string[];
}

function reqStrArray(args: Args, key: string): string[] {
  return strArray(args, key, true)!;
}

function isObj(v: unknown): v is Args {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new ToolError(`${what} must be one of ${allowed.join(", ")} (got ${JSON.stringify(v)})`);
  }
  return v as T;
}

// --- tab resolution ----------------------------------------------------------

function resolveTab(args: Args, defaultTabId?: string): { tabId: string; tab: SceneTab } {
  const explicit = optStr(args, "tabId");
  const tabId = explicit || defaultTabId || getActiveSceneTabId();
  const tab = tabId ? getSceneTab(tabId) : undefined;
  if (!tabId || !tab) {
    const open = listSceneTabs().map((t) => t.tabId);
    throw new ToolError(
      `Canvas tab ${tabId ? `"${tabId}" is not open` : "not found"}. Open tabs: ${open.join(", ") || "(none)"}. Call list_tabs.`,
    );
  }
  return { tabId, tab };
}

function checkRevision(draft: Draft, args: Args): void {
  const expected = optStr(args, "expectedRevision");
  if (expected === undefined) return;
  const actual = draft.revision();
  if (expected !== actual) {
    throw new ToolError(
      `Revision conflict: the canvas changed since revision ${expected} (now ${actual}). ` +
        "Call get_scene_summary to see the current scene, then retry.",
    );
  }
}

/** Map a bound-text id to its container; dedupe; verify existence. */
function resolveTargets(draft: Draft, ids: string[]): El[] {
  const out = new Map<string, El>();
  for (const id of ids) {
    let el = draft.mustGet(id);
    if (isText(el) && el.containerId) el = draft.get(el.containerId) ?? el;
    out.set(el.id, el);
  }
  return [...out.values()];
}

// --- text measurement --------------------------------------------------------

/**
 * Recompute a text element's width/height (wrapping to its container) and position it.
 * `restoreElements(..., {refreshDimensions})` only refreshes when `repairBindings` is also set.
 */
function refreshText(draft: Draft, textId: string): void {
  const text = draft.get(textId);
  if (!text || !isText(text)) return;
  const container = text.containerId ? draft.get(text.containerId) : undefined;
  const restored = restoreElements(container ? [text, container] : [text], null, {
    refreshDimensions: true,
    repairBindings: true,
  }).find((e) => e.id === textId);
  if (restored && isText(restored)) {
    draft.update(textId, { width: restored.width, height: restored.height, text: restored.text });
  }
  if (container && !isLinear(container)) {
    const t = draft.get(textId)!;
    const needed = t.height + 10;
    if (needed > container.height) {
      draft.update(container.id, {
        height: needed,
        y: container.y - (needed - container.height) / 2,
      });
      rerouteAround(draft, [container.id]);
    }
  }
  placeBoundText(draft, textId);
}

function fontFamilyOf(v: unknown): number {
  if (typeof v === "number" && Object.values(FONT_FAMILY).includes(v)) return v;
  if (typeof v === "string") {
    const hit = Object.entries(FONT_FAMILY).find(
      ([name]) => name.toLowerCase() === v.toLowerCase(),
    );
    if (hit) return hit[1];
  }
  throw new ToolError(
    `fontFamily must be one of ${Object.keys(FONT_FAMILY).join(", ")} (or its numeric id)`,
  );
}

function makeTextElement(text: string, extra: Args = {}): El {
  const [el] = convertToExcalidrawElements(
    [{ type: "text", x: 0, y: 0, text, ...extra } as ExcalidrawElementSkeleton],
    { regenerateIds: true },
  );
  return el;
}

// --- read tools --------------------------------------------------------------

function listTabs(): ToolContent[] {
  const active = getActiveSceneTabId();
  return json({
    tabs: listSceneTabs().map(({ tabId, tab }) => ({
      tabId,
      title: tab.title(),
      elementCount: tab.api.getSceneElements().length,
      editable: !tab.isViewer(),
      active: tabId === active,
    })),
  });
}

function sceneSummary(tab: SceneTab, tabId: string, args: Args): ToolContent[] {
  const draft = new Draft(tab.api.getSceneElementsIncludingDeleted());
  const ids = strArray(args, "ids");
  const limit = Math.min(Math.max(Math.trunc(optNum(args, "limit") ?? 200), 1), 500);
  const cursor = optStr(args, "cursor");
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  if (!Number.isFinite(offset) || offset < 0) throw new ToolError(`Invalid cursor "${cursor}"`);

  const live = draft.live();
  let rows: El[];
  const missing: string[] = [];
  if (ids) {
    rows = [];
    for (const id of ids) {
      const el = draft.get(id);
      if (el) rows.push(el);
      else missing.push(id);
    }
  } else {
    rows = live.filter((el) => !isFoldedText(draft, el));
  }
  if (args.bbox !== undefined) {
    if (!isObj(args.bbox)) throw new ToolError(`"bbox" must be {x, y, width, height}`);
    const b = args.bbox;
    const [x, y, w, h] = [b.x, b.y, b.width, b.height].map(Number);
    if ([x, y, w, h].some((n) => !Number.isFinite(n))) {
      throw new ToolError(`"bbox" must be {x, y, width, height} numbers`);
    }
    const box: Box = { minX: x, minY: y, maxX: x + w, maxY: y + h };
    rows = rows.filter((el) => intersects(boundsOf(el), box));
  }
  const page = rows.slice(offset, offset + limit);
  const bounds = unionBounds(live);
  return json({
    tabId,
    revision: revisionOf(draft.toArray()),
    total: rows.length,
    bounds: bounds && {
      x: Math.round(bounds.minX),
      y: Math.round(bounds.minY),
      width: Math.round(bounds.maxX - bounds.minX),
      height: Math.round(bounds.maxY - bounds.minY),
    },
    elements: page.map((el) => rowOf(draft, el)),
    ...(missing.length ? { missing } : {}),
    ...(offset + limit < rows.length ? { nextCursor: String(offset + limit) } : {}),
  });
}

function selection(tab: SceneTab, tabId: string): ToolContent[] {
  const draft = new Draft(tab.api.getSceneElementsIncludingDeleted());
  const selected = Object.entries(tab.api.getAppState().selectedElementIds ?? {})
    .filter(([, on]) => on)
    .map(([id]) => draft.get(id))
    .filter((el): el is El => !!el && !isFoldedText(draft, el));
  return json({
    tabId,
    revision: revisionOf(draft.toArray()),
    ids: selected.map((e) => e.id),
    elements: selected.map((el) => rowOf(draft, el)),
  });
}

function getElements(tab: SceneTab, tabId: string, args: Args): ToolContent[] {
  const ids = reqStrArray(args, "ids");
  if (ids.length > 200) throw new ToolError(`At most 200 ids per call`);
  const draft = new Draft(tab.api.getSceneElementsIncludingDeleted());
  const found: El[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const el = draft.get(id);
    if (el) found.push(el);
    else missing.push(id);
  }
  return json({
    tabId,
    revision: revisionOf(draft.toArray()),
    elements: found,
    ...(missing.length ? { missing } : {}),
  });
}

async function renderPng(tab: SceneTab, tabId: string, args: Args): Promise<ToolContent[]> {
  const scope =
    args.scope === undefined
      ? "all"
      : oneOf(args.scope, ["all", "viewport", "selection", "ids"] as const, "scope");
  const draft = new Draft(tab.api.getSceneElementsIncludingDeleted());
  const appState = tab.api.getAppState();
  let picked: El[];
  if (scope === "all") picked = draft.live();
  else if (scope === "viewport") {
    const [x1, y1, x2, y2] = getVisibleSceneBounds(appState);
    const view: Box = { minX: x1, minY: y1, maxX: x2, maxY: y2 };
    picked = draft.live().filter((el) => intersects(boundsOf(el), view));
  } else {
    const ids =
      scope === "ids"
        ? reqStrArray(args, "ids")
        : Object.entries(appState.selectedElementIds ?? {})
            .filter(([, on]) => on)
            .map(([id]) => id);
    const set = new Set<string>();
    for (const el of resolveTargets(draft, ids)) {
      set.add(el.id);
      const label = draft.boundTextOf(el);
      if (label) set.add(label.id);
    }
    picked = draft.live().filter((el) => set.has(el.id));
  }
  if (!picked.length) throw new ToolError(`Nothing to render for scope "${scope}"`);
  const blob = await exportToBlob({
    elements: picked as never,
    appState: { ...appState, exportBackground: true, exportScale: 1 },
    files: tab.api.getFiles(),
    mimeType: "image/png",
    exportPadding: 16,
    maxWidthOrHeight: 1280,
  });
  const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  return [
    { type: "image", data, mimeType: "image/png" },
    {
      type: "text",
      text: JSON.stringify({
        tabId,
        scope,
        elementCount: picked.length,
        revision: revisionOf(draft.toArray()),
      }),
    },
  ];
}

function setViewport(tab: SceneTab, tabId: string, args: Args): ToolContent[] {
  const zoom = optNum(args, "zoom");
  if (zoom !== undefined && (zoom < 0.1 || zoom > 30)) {
    throw new ToolError(`"zoom" must be between 0.1 and 30`);
  }
  const draft = new Draft(tab.api.getSceneElementsIncludingDeleted());
  const ids = strArray(args, "ids");
  const targets = ids?.length ? resolveTargets(draft, ids) : draft.live();
  if (!targets.length) throw new ToolError(`The canvas is empty; nothing to scroll to`);
  tab.api.scrollToContent(targets, {
    fitToContent: true,
    animate: true,
    ...(zoom !== undefined ? { minZoom: zoom, maxZoom: zoom } : {}),
  });
  return json({ tabId, ok: true, targets: targets.length });
}

function selectedIds(tab: SceneTab): string[] {
  return Object.entries(tab.api.getAppState().selectedElementIds ?? {})
    .filter(([, on]) => on)
    .map(([id]) => id);
}

function selectElements(tab: SceneTab, tabId: string, args: Args): ToolContent[] {
  const mode =
    args.mode === undefined
      ? "replace"
      : oneOf(args.mode, ["replace", "add", "remove", "clear"] as const, "mode");
  const draft = new Draft(tab.api.getSceneElementsIncludingDeleted());
  const ids = mode === "clear" ? [] : reqStrArray(args, "ids");
  const targets = resolveTargets(draft, ids).map((el) => el.id);
  let next = new Set(mode === "add" || mode === "remove" ? selectedIds(tab) : []);
  if (mode === "remove") for (const id of targets) next.delete(id);
  else for (const id of targets) next.add(id);
  next = new Set([...next].filter((id) => draft.get(id)));
  tab.api.updateScene({
    appState: {
      selectedElementIds: Object.fromEntries([...next].map((id) => [id, true as const])),
      selectedGroupIds: {},
      editingGroupId: null,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  } as never);
  if (args.reveal === true && next.size) {
    tab.api.scrollToContent(
      [...next].map((id) => draft.get(id)!),
      { fitToContent: true, animate: true },
    );
  }
  return json({ tabId, revision: revisionOf(draft.toArray()), selected: [...next] });
}

function findElements(tab: SceneTab, tabId: string, args: Args): ToolContent[] {
  const draft = new Draft(tab.api.getSceneElementsIncludingDeleted());
  const text = optStr(args, "text");
  let pattern: RegExp | undefined;
  if (text !== undefined && args.regex === true) {
    try {
      pattern = new RegExp(text, "i");
    } catch (err) {
      throw new ToolError(`Invalid regex: ${(err as Error).message}`);
    }
  }
  const needle = text?.toLowerCase();
  const types = strArray(args, "types");
  const stroke = optStr(args, "strokeColor")?.toLowerCase();
  const bg = optStr(args, "backgroundColor")?.toLowerCase();
  const groupId = optStr(args, "groupId");
  const frameId = optStr(args, "frameId");
  const limit = Math.min(Math.max(Math.trunc(optNum(args, "limit") ?? 100), 1), 500);
  let box: Box | undefined;
  if (args.bbox !== undefined) {
    if (!isObj(args.bbox)) throw new ToolError(`"bbox" must be {x, y, width, height}`);
    const [x, y, w, h] = [args.bbox.x, args.bbox.y, args.bbox.width, args.bbox.height].map(Number);
    if ([x, y, w, h].some((n) => !Number.isFinite(n))) {
      throw new ToolError(`"bbox" must be {x, y, width, height} numbers`);
    }
    box = { minX: x, minY: y, maxX: x + w, maxY: y + h };
  }
  const textOf = (el: El) =>
    isText(el)
      ? el.text
      : (draft.boundTextOf(el)?.text ??
        (el.type === "frame" ? ((el as { name?: string | null }).name ?? "") : ""));
  const hits = draft.live().filter((el) => {
    if (isFoldedText(draft, el)) return false;
    if (types && !types.includes(el.type)) return false;
    if (stroke && el.strokeColor.toLowerCase() !== stroke) return false;
    if (bg && el.backgroundColor.toLowerCase() !== bg) return false;
    if (groupId && !el.groupIds.includes(groupId)) return false;
    if (frameId && el.frameId !== frameId) return false;
    if (box && !intersects(boundsOf(el), box)) return false;
    if (text !== undefined) {
      const t = textOf(el);
      if (pattern ? !pattern.test(t) : !t.toLowerCase().includes(needle!)) return false;
    }
    return true;
  });
  return json({
    tabId,
    revision: revisionOf(draft.toArray()),
    total: hits.length,
    elements: hits.slice(0, limit).map((el) => rowOf(draft, el)),
  });
}

function canvasState(tab: SceneTab, tabId: string): ToolContent[] {
  const draft = new Draft(tab.api.getSceneElementsIncludingDeleted());
  const s = tab.api.getAppState() as unknown as Record<string, unknown> &
    Parameters<typeof getVisibleSceneBounds>[0];
  const [x1, y1, x2, y2] = getVisibleSceneBounds(s);
  const live = draft.live();
  const bounds = unionBounds(live);
  const box = (b: Box) => ({
    x: Math.round(b.minX),
    y: Math.round(b.minY),
    width: Math.round(b.maxX - b.minX),
    height: Math.round(b.maxY - b.minY),
  });
  const pick = (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
  return json({
    tabId,
    revision: revisionOf(draft.toArray()),
    editable: !tab.isViewer(),
    elementCount: live.filter((el) => !isFoldedText(draft, el)).length,
    sceneBounds: bounds && box(bounds),
    viewport: { ...box({ minX: x1, minY: y1, maxX: x2, maxY: y2 }), zoom: s.zoom?.value ?? 1 },
    selection: selectedIds(tab),
    ...pick([
      "theme",
      "viewBackgroundColor",
      "gridModeEnabled",
      "gridSize",
      "viewModeEnabled",
      "zenModeEnabled",
      "activeTool",
    ]),
    currentItemStyle: Object.fromEntries(
      Object.entries(s)
        .filter(([k]) => k.startsWith("currentItem"))
        .map(([k, v]) => [
          k.slice("currentItem".length, "currentItem".length + 1).toLowerCase() +
            k.slice("currentItem".length + 1),
          v,
        ]),
    ),
  });
}

function setCanvas(tab: SceneTab, tabId: string, args: Args): ToolContent[] {
  const appState: Args = {};
  const bg = optStr(args, "viewBackgroundColor");
  if (bg !== undefined) appState.viewBackgroundColor = bg;
  if (args.gridModeEnabled !== undefined) {
    if (typeof args.gridModeEnabled !== "boolean")
      throw new ToolError(`"gridModeEnabled" must be a boolean`);
    appState.gridModeEnabled = args.gridModeEnabled;
  }
  if (!Object.keys(appState).length) {
    throw new ToolError(`Pass viewBackgroundColor and/or gridModeEnabled`);
  }
  tab.api.updateScene({
    appState,
    captureUpdate: bg !== undefined ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER,
  } as never);
  if (bg !== undefined) tab.markDirty();
  return json({ tabId, ...appState });
}

// --- edit tools --------------------------------------------------------------

interface EditCtx {
  files: BinaryFileData[];
  /** Pre-parsed mermaid results keyed by the args object (parsing is async). */
  mermaid: Map<Args, MermaidPrepared>;
}

const SKELETON_TYPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "frame",
] as const;

function addElements(draft: Draft, args: Args): unknown {
  const items = reqArray(args, "elements");
  if (items.length > 300) throw new ToolError(`At most 300 elements per call`);
  const batchIds = new Set<string>();
  const deferred: Array<{ id: string; side: "start" | "end"; target: string }> = [];
  const skeletons = items.map((raw, i) => {
    if (!isObj(raw)) throw new ToolError(`elements[${i}] must be an object`);
    const type = oneOf(raw.type, SKELETON_TYPES, `elements[${i}].type`);
    const sk: Args = { ...raw };
    if (sk.id !== undefined) {
      if (typeof sk.id !== "string" || !sk.id)
        throw new ToolError(`elements[${i}].id must be a string`);
      if (draft.has(sk.id)) {
        throw new ToolError(
          `elements[${i}].id "${sk.id}" already exists on the canvas; choose another id or omit it`,
        );
      }
      if (batchIds.has(sk.id)) throw new ToolError(`Duplicate id "${sk.id}" in elements`);
      batchIds.add(sk.id);
    } else {
      sk.id = newId();
    }
    if (type === "arrow" || type === "line") {
      for (const side of ["start", "end"] as const) {
        const ref = sk[side];
        if (!isObj(ref) || typeof ref.id !== "string" || ref.type !== undefined) continue;
        if (draft.get(ref.id)) {
          if (type === "line")
            throw new ToolError(`elements[${i}]: only arrows can bind to elements`);
          deferred.push({ id: sk.id as string, side, target: ref.id });
          delete sk[side];
        } else if (!items.some((o) => isObj(o) && o.id === ref.id)) {
          throw new ToolError(`elements[${i}].${side}.id "${ref.id}" does not exist`);
        }
      }
      if (deferred.some((d) => d.id === sk.id)) {
        sk.x ??= 0;
        sk.y ??= 0;
      }
    }
    if (type !== "arrow" && type !== "line" && type !== "text") {
      if (typeof sk.x !== "number" || typeof sk.y !== "number") {
        throw new ToolError(`elements[${i}] (${type}) needs numeric x and y`);
      }
    }
    return sk as unknown as ExcalidrawElementSkeleton;
  });
  const converted = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  for (const el of converted) draft.add(el);
  for (const d of deferred) draft.bindArrow(d.id, d.side, d.target);
  for (const id of new Set(deferred.map((d) => d.id))) routeArrow(draft, id);
  return {
    created: skeletons.map((sk) => {
      const el = draft.get((sk as { id: string }).id)!;
      const label = draft.boundTextOf(el);
      return { id: el.id, type: el.type, ...(label ? { labelId: label.id } : {}) };
    }),
  };
}

const STYLE_ENUMS: Record<string, readonly string[]> = {
  fillStyle: ["hachure", "cross-hatch", "solid", "zigzag"],
  strokeStyle: ["solid", "dashed", "dotted"],
};
const UPDATE_FIELDS = new Set([
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "text",
  "fontSize",
  "fontFamily",
  "textAlign",
  "roundness",
  "locked",
  "link",
]);

function updateElements(draft: Draft, args: Args): unknown {
  const updates = reqArray(args, "updates");
  const updated: string[] = [];
  for (const [i, u] of updates.entries()) {
    if (!isObj(u) || typeof u.id !== "string" || !isObj(u.patch)) {
      throw new ToolError(`updates[${i}] must be {id, patch}`);
    }
    const el = draft.mustGet(u.id);
    const patch = u.patch;
    const unknown = Object.keys(patch).filter((k) => !UPDATE_FIELDS.has(k));
    if (unknown.length) {
      throw new ToolError(
        `updates[${i}]: unsupported field(s) ${unknown.join(", ")}. Allowed: ${[...UPDATE_FIELDS].join(", ")}`,
      );
    }
    const own: Args = {};
    const textPatch: Args = {};
    for (const [k, v] of Object.entries(patch)) {
      switch (k) {
        case "strokeColor":
        case "backgroundColor":
          if (typeof v !== "string") throw new ToolError(`${k} must be a color string`);
          own[k] = v;
          break;
        case "fillStyle":
        case "strokeStyle":
          own[k] = oneOf(v, STYLE_ENUMS[k], k);
          break;
        case "strokeWidth":
        case "angle":
          if (typeof v !== "number" || !Number.isFinite(v))
            throw new ToolError(`${k} must be a number`);
          own[k] = v;
          break;
        case "roughness":
          if (typeof v !== "number" || v < 0 || v > 2)
            throw new ToolError(`roughness must be 0, 1 or 2`);
          own[k] = v;
          break;
        case "opacity":
          if (typeof v !== "number" || v < 0 || v > 100)
            throw new ToolError(`opacity must be 0-100`);
          own[k] = v;
          break;
        case "locked":
          if (typeof v !== "boolean") throw new ToolError(`locked must be a boolean`);
          own[k] = v;
          break;
        case "link":
          if (v !== null && typeof v !== "string")
            throw new ToolError(`link must be a string or null`);
          own[k] = v || null;
          break;
        case "roundness":
          if (v === null || v === "sharp") own.roundness = null;
          else if (v === "round") own.roundness = { type: isLinear(el) ? 2 : 3 };
          else throw new ToolError(`roundness must be "round", "sharp" or null`);
          break;
        case "text":
          if (typeof v !== "string") throw new ToolError(`text must be a string`);
          textPatch.text = v;
          break;
        case "fontSize":
          if (typeof v !== "number" || v <= 0)
            throw new ToolError(`fontSize must be a positive number`);
          textPatch.fontSize = v;
          break;
        case "fontFamily":
          textPatch.fontFamily = fontFamilyOf(v);
          break;
        case "textAlign":
          textPatch.textAlign = oneOf(v, ["left", "center", "right"] as const, "textAlign");
          break;
      }
    }
    if (Object.keys(own).length) draft.update(el.id, own);

    const hasSize = patch.width !== undefined || patch.height !== undefined;
    if (hasSize) {
      if (isText(el))
        throw new ToolError(`Text size follows its content; change fontSize or text instead`);
      const cur = draft.get(el.id)!;
      const w = patch.width === undefined ? cur.width : Number(patch.width);
      const h = patch.height === undefined ? cur.height : Number(patch.height);
      if (!(w >= 0) || !(h >= 0)) throw new ToolError(`width/height must be non-negative numbers`);
      if (isLinear(cur)) {
        const sx = cur.width ? w / cur.width : 1;
        const sy = cur.height ? h / cur.height : 1;
        draft.update(cur.id, {
          width: w,
          height: h,
          points: cur.points.map(([px, py]) => [px * sx, py * sy]),
        });
      } else {
        draft.update(cur.id, { width: w, height: h });
      }
    }

    if (Object.keys(textPatch).length) applyTextPatch(draft, el.id, textPatch);
    else if (hasSize) {
      const label = draft.boundTextOf(draft.get(el.id)!);
      if (label) refreshText(draft, label.id);
    }

    const now = draft.get(el.id)!;
    const dx = patch.x === undefined ? 0 : Number(patch.x) - now.x;
    const dy = patch.y === undefined ? 0 : Number(patch.y) - now.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new ToolError(`x/y must be numbers`);
    if (dx || dy) moveElements(draft, new Map([[el.id, [dx, dy]]]));
    else if (hasSize) rerouteAround(draft, [el.id]);
    updated.push(el.id);
  }
  return { updated };
}

function applyTextPatch(draft: Draft, id: string, patch: Args): void {
  const el = draft.get(id)!;
  if (isText(el)) {
    if (patch.text === "") throw new ToolError(`Use delete_elements to remove a text element`);
    if (patch.text !== undefined) patch.originalText = patch.text;
    draft.update(id, patch);
    refreshText(draft, id);
    return;
  }
  if (!["rectangle", "ellipse", "diamond", "arrow"].includes(el.type)) {
    throw new ToolError(`${el.type} elements can't hold text`);
  }
  const label = draft.boundTextOf(el);
  if (label) {
    if (patch.text === "") {
      draft.update(label.id, { isDeleted: true });
      draft.update(id, {
        boundElements: (el.boundElements ?? []).filter((b) => b.id !== label.id),
      });
      return;
    }
    if (patch.text !== undefined) patch.originalText = patch.text;
    draft.update(label.id, patch);
    refreshText(draft, label.id);
    return;
  }
  if (typeof patch.text !== "string" || !patch.text) {
    throw new ToolError(`Element "${id}" has no label; pass non-empty "text" to create one`);
  }
  const text = makeTextElement(patch.text, {
    ...patch,
    textAlign: patch.textAlign ?? "center",
    verticalAlign: "middle",
    strokeColor: el.strokeColor,
  });
  draft.add(text);
  draft.update(text.id, { containerId: id });
  draft.addBoundElement(id, { id: text.id, type: "text" });
  refreshText(draft, text.id);
}

function deleteElements(draft: Draft, args: Args): unknown {
  const ids = reqStrArray(args, "ids");
  const doomed = new Set<string>();
  for (const id of ids) doomed.add(draft.mustGet(id).id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const el of draft.live()) {
      if (doomed.has(el.id)) continue;
      const hit =
        (isText(el) && el.containerId && doomed.has(el.containerId)) ||
        (el.frameId && doomed.has(el.frameId)) ||
        (isLinear(el) &&
          ((el.startBinding && doomed.has(el.startBinding.elementId)) ||
            (el.endBinding && doomed.has(el.endBinding.elementId))));
      if (hit) {
        doomed.add(el.id);
        grew = true;
      }
    }
  }
  for (const id of doomed) draft.update(id, { isDeleted: true });
  for (const el of draft.live()) {
    const refs = el.boundElements;
    if (refs?.some((b) => doomed.has(b.id))) {
      draft.update(el.id, { boundElements: refs.filter((b) => !doomed.has(b.id)) });
    }
  }
  return { deleted: [...doomed] };
}

const CONNECT_STYLE = new Set([
  "strokeColor",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "startArrowhead",
  "endArrowhead",
]);

function connect(draft: Draft, args: Args): unknown {
  const from = draft.mustGet(optStr(args, "from"));
  const to = draft.mustGet(optStr(args, "to"));
  if (from.id === to.id) throw new ToolError(`"from" and "to" must be different elements`);
  for (const el of [from, to]) {
    if (!BINDABLE_TYPES.has(el.type))
      throw new ToolError(`Can't connect to a ${el.type} ("${el.id}")`);
  }
  const style: Args = {};
  if (args.style !== undefined) {
    if (!isObj(args.style)) throw new ToolError(`"style" must be an object`);
    for (const [k, v] of Object.entries(args.style)) {
      if (!CONNECT_STYLE.has(k)) {
        throw new ToolError(`Unsupported style "${k}". Allowed: ${[...CONNECT_STYLE].join(", ")}`);
      }
      style[k] = v;
    }
    if (style.strokeStyle !== undefined)
      oneOf(style.strokeStyle, STYLE_ENUMS.strokeStyle, "strokeStyle");
  }
  const label = optStr(args, "label");
  const id = newId();
  const skeleton = {
    type: "arrow",
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 0,
    ...style,
    ...(label ? { label: { text: label } } : {}),
  } as unknown as ExcalidrawElementSkeleton;
  for (const el of convertToExcalidrawElements([skeleton], { regenerateIds: false })) draft.add(el);
  draft.bindArrow(id, "start", from.id);
  draft.bindArrow(id, "end", to.id);
  routeArrow(draft, id);
  const labelEl = draft.boundTextOf(draft.get(id)!);
  if (labelEl) refreshText(draft, labelEl.id);
  return { id, ...(labelEl ? { labelId: labelEl.id } : {}) };
}

interface MermaidPrepared {
  elements: El[];
  files: BinaryFileData[];
}

async function prepareMermaid(args: Args): Promise<MermaidPrepared> {
  const source = optStr(args, "mermaid");
  if (!source?.trim()) throw new ToolError(`"mermaid" source is required`);
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  let parsed;
  try {
    parsed = await parseMermaidToExcalidraw(source, { themeVariables: { fontSize: "16px" } });
  } catch (err) {
    throw new ToolError(
      `Mermaid parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const elements = convertToExcalidrawElements(parsed.elements as ExcalidrawElementSkeleton[], {
    regenerateIds: true,
  });
  return { elements, files: Object.values(parsed.files ?? {}) as BinaryFileData[] };
}

function addMermaid(draft: Draft, args: Args, ctx: EditCtx): unknown {
  const prepared = ctx.mermaid.get(args);
  if (!prepared) throw new ToolError(`Mermaid diagram was not prepared`);
  const els = prepared.elements;
  if (!els.length) throw new ToolError(`Mermaid produced no elements`);
  const box = unionBounds(els)!;
  let x = optNum(args, "x");
  let y = optNum(args, "y");
  if (x === undefined || y === undefined) {
    const existing = unionBounds(draft.live());
    x ??= existing ? existing.maxX + 80 : 0;
    y ??= existing ? existing.minY : 0;
  }
  const dx = x - box.minX;
  const dy = y - box.minY;
  for (const el of els) {
    if (draft.has(el.id)) throw new ToolError(`Mermaid element id collision "${el.id}"; retry`);
    draft.add({ ...el, x: el.x + dx, y: el.y + dy });
  }
  ctx.files.push(...prepared.files);
  const imageFallback = els.some((e) => e.type === "image");
  return {
    created: els.length,
    ids: els.filter((e) => !isFoldedText(draft, e)).map((e) => e.id),
    imageFallback,
    ...(imageFallback
      ? {
          note: "This Mermaid diagram type isn't convertible to native shapes; it was inserted as an image.",
        }
      : {}),
  };
}

/** Targets plus, for frames, everything inside them. */
function withFrameChildren(draft: Draft, targets: El[]): El[] {
  const out = new Map(targets.map((el) => [el.id, el]));
  for (const t of targets) {
    if (t.type !== "frame" && t.type !== "magicframe") continue;
    for (const el of draft.live()) {
      if (el.frameId === t.id && !isFoldedText(draft, el)) out.set(el.id, el);
    }
  }
  return [...out.values()];
}

function moveBy(draft: Draft, args: Args): unknown {
  const dx = optNum(args, "dx") ?? 0;
  const dy = optNum(args, "dy") ?? 0;
  if (!dx && !dy) throw new ToolError(`Pass a non-zero dx and/or dy`);
  const targets = withFrameChildren(draft, resolveTargets(draft, reqStrArray(args, "ids")));
  moveElements(draft, new Map(targets.map((el) => [el.id, [dx, dy] as [number, number]])));
  return { moved: targets.map((el) => el.id) };
}

function duplicate(draft: Draft, args: Args): unknown {
  const dx = optNum(args, "dx") ?? 20;
  const dy = optNum(args, "dy") ?? 20;
  const picked = new Set<string>();
  for (const el of withFrameChildren(draft, resolveTargets(draft, reqStrArray(args, "ids")))) {
    picked.add(el.id);
  }
  // Arrows whose both ends are being copied come along, as in Excalidraw's own duplicate.
  for (const el of draft.live()) {
    if (
      isLinear(el) &&
      el.startBinding &&
      el.endBinding &&
      picked.has(el.startBinding.elementId) &&
      picked.has(el.endBinding.elementId)
    ) {
      picked.add(el.id);
    }
  }
  for (const id of [...picked]) {
    const label = draft.boundTextOf(draft.get(id)!);
    if (label) picked.add(label.id);
  }
  const idMap = new Map([...picked].map((id) => [id, newId()]));
  const groupMap = new Map<string, string>();
  const remapGroup = (g: string) => {
    if (!groupMap.has(g)) groupMap.set(g, newId());
    return groupMap.get(g)!;
  };
  const rebind = <B extends { elementId: string } | null>(b: B): B | null =>
    b && idMap.has(b.elementId) ? { ...b, elementId: idMap.get(b.elementId)! } : null;
  const rand = () => Math.floor(Math.random() * 2 ** 31);
  for (const el of draft.live().filter((e) => picked.has(e.id))) {
    const clone = {
      ...el,
      id: idMap.get(el.id)!,
      x: el.x + dx,
      y: el.y + dy,
      seed: rand(),
      version: 1,
      versionNonce: rand(),
      index: null,
      updated: Date.now(),
      groupIds: el.groupIds.map(remapGroup),
      frameId: el.frameId ? (idMap.get(el.frameId) ?? el.frameId) : null,
      boundElements:
        el.boundElements
          ?.filter((b) => idMap.has(b.id))
          .map((b) => ({ ...b, id: idMap.get(b.id)! })) ?? null,
      ...(isText(el) && el.containerId ? { containerId: idMap.get(el.containerId) ?? null } : {}),
      ...(isLinear(el)
        ? { startBinding: rebind(el.startBinding), endBinding: rebind(el.endBinding) }
        : {}),
    } as El;
    draft.add(clone);
  }
  return { created: Object.fromEntries(idMap) };
}

function arrange(draft: Draft, args: Args): unknown {
  const action = oneOf(
    args.action,
    ["align", "distribute", "grid", "group", "ungroup", "zorder", "frame"] as const,
    "action",
  );
  const targets = resolveTargets(draft, reqStrArray(args, "ids"));
  const withLabels = (els: El[]) => {
    const ids = new Set<string>();
    for (const el of els) {
      ids.add(el.id);
      const label = draft.boundTextOf(el);
      if (label) ids.add(label.id);
    }
    return ids;
  };

  switch (action) {
    case "align": {
      const value = oneOf(
        args.value,
        ["left", "center", "right", "top", "middle", "bottom"] as const,
        "align value",
      );
      const all = unionBounds(targets)!;
      const moves = new Map<string, [number, number]>();
      for (const el of targets) {
        const b = boundsOf(el);
        const w = b.maxX - b.minX;
        const h = b.maxY - b.minY;
        const dx =
          value === "left"
            ? all.minX - b.minX
            : value === "right"
              ? all.maxX - b.maxX
              : value === "center"
                ? (all.minX + all.maxX) / 2 - (b.minX + w / 2)
                : 0;
        const dy =
          value === "top"
            ? all.minY - b.minY
            : value === "bottom"
              ? all.maxY - b.maxY
              : value === "middle"
                ? (all.minY + all.maxY) / 2 - (b.minY + h / 2)
                : 0;
        moves.set(el.id, [dx, dy]);
      }
      moveElements(draft, moves);
      break;
    }
    case "distribute": {
      const value = oneOf(
        args.value ?? "horizontal",
        ["horizontal", "vertical"] as const,
        "distribute value",
      );
      if (targets.length < 3) throw new ToolError(`distribute needs at least 3 elements`);
      const h = value === "horizontal";
      const items = targets
        .map((el) => ({ el, b: boundsOf(el) }))
        .sort((a, b) => (h ? a.b.minX - b.b.minX : a.b.minY - b.b.minY));
      const lo = h ? items[0].b.minX : items[0].b.minY;
      const hi = Math.max(...items.map(({ b }) => (h ? b.maxX : b.maxY)));
      const sizes = items.map(({ b }) => (h ? b.maxX - b.minX : b.maxY - b.minY));
      const gap = (hi - lo - sizes.reduce((s, n) => s + n, 0)) / (items.length - 1);
      let pos = lo;
      const moves = new Map<string, [number, number]>();
      items.forEach(({ el, b }, i) => {
        const delta = pos - (h ? b.minX : b.minY);
        moves.set(el.id, h ? [delta, 0] : [0, delta]);
        pos += sizes[i] + gap;
      });
      moveElements(draft, moves);
      break;
    }
    case "grid": {
      const columns = Math.trunc(optNum(args, "columns") ?? Math.ceil(Math.sqrt(targets.length)));
      if (columns < 1) throw new ToolError(`columns must be >= 1`);
      const gap = optNum(args, "gap") ?? 40;
      const boxes = targets.map(boundsOf);
      const cw = Math.max(...boxes.map((b) => b.maxX - b.minX));
      const ch = Math.max(...boxes.map((b) => b.maxY - b.minY));
      const origin = unionBounds(targets)!;
      const moves = new Map<string, [number, number]>();
      targets.forEach((el, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        moves.set(el.id, [
          origin.minX + col * (cw + gap) - boxes[i].minX,
          origin.minY + row * (ch + gap) - boxes[i].minY,
        ]);
      });
      moveElements(draft, moves);
      break;
    }
    case "group": {
      if (targets.length < 2) throw new ToolError(`group needs at least 2 elements`);
      const groupId = newId();
      for (const id of withLabels(targets)) {
        draft.update(id, { groupIds: [...draft.get(id)!.groupIds, groupId] });
      }
      return { groupId };
    }
    case "ungroup": {
      const gids = new Set(
        targets.map((el) => el.groupIds[el.groupIds.length - 1]).filter((g): g is string => !!g),
      );
      if (!gids.size) throw new ToolError(`None of these elements are grouped`);
      for (const el of draft.live()) {
        if (el.groupIds.some((g) => gids.has(g))) {
          draft.update(el.id, { groupIds: el.groupIds.filter((g) => !gids.has(g)) });
        }
      }
      return { ungrouped: [...gids] };
    }
    case "zorder": {
      const value = oneOf(args.value, ["front", "back"] as const, "zorder value");
      draft.reorder(withLabels(targets), value);
      break;
    }
    case "frame": {
      // value = a frame id to put the elements in, or omitted/"none" to take them out.
      const frameId = args.value === undefined || args.value === "none" ? null : args.value;
      if (frameId !== null) {
        const frame = draft.mustGet(frameId);
        if (frame.type !== "frame" && frame.type !== "magicframe") {
          throw new ToolError(`"${String(frameId)}" is a ${frame.type}, not a frame`);
        }
      }
      for (const id of withLabels(targets)) {
        if (id === frameId) throw new ToolError(`A frame can't contain itself`);
        draft.update(id, { frameId: frameId as string | null });
      }
      break;
    }
  }
  return { arranged: targets.map((el) => el.id) };
}

function applyEdit(tool: string, draft: Draft, args: Args, ctx: EditCtx): unknown {
  switch (tool) {
    case "add_elements":
      return addElements(draft, args);
    case "update_elements":
      return updateElements(draft, args);
    case "delete_elements":
      return deleteElements(draft, args);
    case "connect":
      return connect(draft, args);
    case "add_mermaid":
      return addMermaid(draft, args, ctx);
    case "arrange":
      return arrange(draft, args);
    case "move_elements":
      return moveBy(draft, args);
    case "duplicate_elements":
      return duplicate(draft, args);
    default:
      throw new ToolError(`"${tool}" can't be used here`);
  }
}

function opsOf(args: Args): Array<{ tool: string; args: Args }> {
  const ops = reqArray(args, "ops");
  if (ops.length > 50) throw new ToolError(`At most 50 ops per call`);
  return ops.map((op, i) => {
    if (!isObj(op) || typeof op.tool !== "string" || !isObj(op.args)) {
      throw new ToolError(`ops[${i}] must be {tool, args}`);
    }
    if (!EDIT_TOOLS.has(op.tool)) {
      throw new ToolError(
        `ops[${i}].tool "${op.tool}" is not an edit tool (${[...EDIT_TOOLS].join(", ")})`,
      );
    }
    return { tool: op.tool, args: op.args };
  });
}

async function runEdit(
  tool: string,
  tab: SceneTab,
  tabId: string,
  args: Args,
): Promise<ToolContent[]> {
  const ctx: EditCtx = { files: [], mermaid: new Map() };
  const ops = tool === "apply_ops" ? opsOf(args) : [{ tool, args }];
  // Async preparation first, so applying the draft below is one synchronous step.
  for (const [i, op] of ops.entries()) {
    if (op.tool !== "add_mermaid") continue;
    try {
      ctx.mermaid.set(op.args, await prepareMermaid(op.args));
    } catch (err) {
      if (tool !== "apply_ops") throw err;
      throw new ToolError(
        `op ${i} (add_mermaid) failed: ${(err as Error).message}; no changes were applied`,
      );
    }
  }

  const draft = new Draft(tab.api.getSceneElementsIncludingDeleted());
  checkRevision(draft, args);
  let result: unknown;
  if (tool === "apply_ops") {
    const results: unknown[] = [];
    for (const [i, op] of ops.entries()) {
      try {
        results.push(applyEdit(op.tool, draft, op.args, ctx));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ToolError(`op ${i} (${op.tool}) failed: ${msg}; no changes were applied`);
      }
    }
    result = { results };
  } else {
    result = applyEdit(tool, draft, args, ctx);
  }
  commitDraft(tabId, tab, draft, ctx.files);
  return json({
    tabId,
    ...(result as object),
    revision: revisionOf(tab.api.getSceneElementsIncludingDeleted()),
  });
}

/**
 * Execute one canvas tool. `defaultTabId` is the tab the calling agent session is bound to;
 * `args.tabId` overrides it, and the active tab is the last resort. Throws `ToolError` (or any
 * error) on failure — toolExecutor.ts turns that into an `isError` MCP result.
 */
export async function runSceneTool(
  tool: string,
  rawArgs: unknown,
  defaultTabId?: string,
): Promise<ToolContent[]> {
  if (!READ_ONLY.has(tool)) throw new ToolError(`Unknown canvas tool "${tool}"`);
  const args: Args = isObj(rawArgs) ? rawArgs : {};
  if (tool === "list_tabs") return listTabs();
  const { tabId, tab } = resolveTab(args, defaultTabId);
  if (READ_ONLY.get(tool) === false && tab.isViewer()) {
    throw new ToolError(
      `Tab "${tab.title()}" is view-only (you joined a live session as a viewer); edits are not allowed. ` +
        "Ask the user to switch to an editable tab.",
    );
  }
  switch (tool) {
    case "get_scene_summary":
      return sceneSummary(tab, tabId, args);
    case "get_selection":
      return selection(tab, tabId);
    case "get_elements":
      return getElements(tab, tabId, args);
    case "render_canvas_png":
      return renderPng(tab, tabId, args);
    case "set_viewport":
      return setViewport(tab, tabId, args);
    case "select_elements":
      return selectElements(tab, tabId, args);
    case "find_elements":
      return findElements(tab, tabId, args);
    case "get_canvas_state":
      return canvasState(tab, tabId);
    case "set_canvas":
      return setCanvas(tab, tabId, args);
    default:
      return runEdit(tool, tab, tabId, args);
  }
}
