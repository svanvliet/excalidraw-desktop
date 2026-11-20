/**
 * Extension stacks (docs/extensions.md § Stacking): reading / migrating the chain stored in
 * `element.customData[EXT_KEY]`, and re-rendering the recorded original through the whole chain
 * whenever one link is applied, re-parameterised or removed.
 */
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
  ImageCrop,
} from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import { basePlan, outputFileId, restoreBounds, type Rect } from "./pipeline";
import { loadSource, type RenderStep } from "./raster";
import { getExtension } from "./registry";
import {
  EXT_KEY,
  STACK_VERSION,
  type AnyDesktopExtension,
  type ExtensionContext,
  type ExtensionLink,
  type ExtensionResult,
  type ExtensionStack,
  type StackSource,
} from "./types";

export type StackRead =
  | { kind: "none" }
  /** `current`: the element still shows the chain's output (else it is stale). */
  | { kind: "ok"; stack: ExtensionStack; current: boolean; legacy: boolean }
  /** Can't be re-rendered here (newer app version, unknown extension, damaged settings). */
  | { kind: "unreadable"; ids: string[]; reason: string };

function rawOf(el: ExcalidrawElement): Record<string, unknown> | null {
  const raw = (el.customData as Record<string, unknown> | undefined)?.[EXT_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function readSource(s: unknown): StackSource | null {
  if (!s || typeof s !== "object") return null;
  const src = s as Partial<StackSource>;
  if (typeof src.fileId !== "string" || !src.fileId) return null;
  const nums = [src.x, src.y, src.width, src.height, src.appliedWidth, src.appliedHeight];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    fileId: src.fileId,
    x: src.x!,
    y: src.y!,
    width: src.width!,
    height: src.height!,
    crop: (src.crop as ImageCrop | null | undefined) ?? null,
    appliedWidth: src.appliedWidth!,
    appliedHeight: src.appliedHeight!,
  };
}

const idsOf = (chain: unknown[]) =>
  chain
    .map((l) => (l && typeof l === "object" ? (l as { ext?: unknown }).ext : undefined))
    .filter((id): id is string => typeof id === "string");

const stageOf = (id: string) => getExtension(id)?.stage ?? Number.MAX_SAFE_INTEGER;

/** Canonical order: ascending stage, then id; one link per extension (the last one wins). */
export function canonicalChain(chain: readonly ExtensionLink[]): ExtensionLink[] {
  const byId = new Map<string, ExtensionLink>();
  for (const l of chain) byId.set(l.ext, l);
  return [...byId.values()].sort((a, b) => stageOf(a.ext) - stageOf(b.ext) || (a.ext < b.ext ? -1 : 1));
}

/**
 * Reads the stored stack. Accepts the current format (`{v: 2, chain, source, outputFileId}`) and
 * migrates the v1 single-extension format (`{ext, v, params, source, outputFileId}`) on read; the
 * new format is written on the next apply/remove. Link params are migrated and normalized.
 */
export function readStack(el: ExcalidrawElement): StackRead {
  const raw = rawOf(el);
  if (!raw) return { kind: "none" };
  let rawChain: unknown[];
  let legacy = false;
  if (Array.isArray(raw.chain)) {
    rawChain = raw.chain;
    if (raw.v !== STACK_VERSION) {
      return {
        kind: "unreadable",
        ids: idsOf(rawChain),
        reason: "it was saved by a newer version of the app",
      };
    }
  } else if (typeof raw.ext === "string") {
    legacy = true;
    rawChain = [{ ext: raw.ext, v: raw.v, params: raw.params }];
  } else {
    return { kind: "none" };
  }
  const ids = idsOf(rawChain);
  const damaged = { kind: "unreadable" as const, ids, reason: "its stored settings are damaged" };
  const source = readSource(raw.source);
  if (!source || typeof raw.outputFileId !== "string" || !rawChain.length) return damaged;

  const chain: ExtensionLink[] = [];
  for (const item of rawChain) {
    if (!item || typeof item !== "object") return damaged;
    const { ext: id, v, params } = item as Record<string, unknown>;
    const ext = typeof id === "string" ? getExtension(id) : undefined;
    if (!ext) {
      return { kind: "unreadable", ids, reason: `it uses an unknown extension ${JSON.stringify(id)}` };
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return damaged;
    if (v > ext.version) {
      return { kind: "unreadable", ids, reason: `${ext.title} was saved by a newer version of the app` };
    }
    let p =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    if (v < ext.version && ext.migrateParams) p = ext.migrateParams(p, v);
    try {
      p = { ...(ext.normalizeParams(p) as Record<string, unknown>) };
    } catch {
      return { kind: "unreadable", ids, reason: `its ${ext.title} settings are invalid` };
    }
    chain.push({ ext: ext.id, v: ext.version, params: p });
  }
  const stack: ExtensionStack = {
    v: STACK_VERSION,
    chain: canonicalChain(chain),
    source,
    outputFileId: raw.outputFileId as FileId,
  };
  const current = el.type === "image" && el.fileId === stack.outputFileId;
  return { kind: "ok", stack, current, legacy };
}

/** The applied (current, readable) links of an element, in chain order. */
export function appliedLinks(el: ExcalidrawElement): ExtensionLink[] {
  const read = readStack(el);
  return read.kind === "ok" && read.current ? read.stack.chain : [];
}

/** The applied link for `extId`, or null when not applied, stale or unreadable. */
export function linkOf(el: ExcalidrawElement, extId: string): ExtensionLink | null {
  return appliedLinks(el).find((l) => l.ext === extId) ?? null;
}

export interface ElementExtensionState {
  /** Applied extensions → their params, in chain order. */
  applied: Record<string, Record<string, unknown>>;
  /** Extension ids whose stored settings no longer match the element (edited elsewhere) or can't be read. */
  stale: string[];
}

/** What extensions are applied to an element, for the UI and the agent's read tools. */
export function extensionStateOf(el: ExcalidrawElement): ElementExtensionState | null {
  const read = readStack(el);
  if (read.kind === "none") return null;
  if (read.kind === "unreadable") return { applied: {}, stale: read.ids };
  if (!read.current) return { applied: {}, stale: read.stack.chain.map((l) => l.ext) };
  return {
    applied: Object.fromEntries(read.stack.chain.map((l) => [l.ext, l.params])),
    stale: [],
  };
}

/**
 * Files the stored stack depends on beyond the element's own `fileId` — by convention
 * `source.fileId` / `source.fileIds` (e.g. the undecorated original). Read from the raw data so
 * even stacks this version can't interpret keep their files alive.
 */
export function stackFileIds(el: ExcalidrawElement): string[] {
  const src = rawOf(el)?.source;
  if (!src || typeof src !== "object") return [];
  const s = src as Record<string, unknown>;
  const ids = [s.fileId, ...(Array.isArray(s.fileIds) ? s.fileIds : [])];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Extension source files referenced by these elements (callers filter deleted ones). */
export function extensionReferencedFileIds(elements: readonly ExcalidrawElement[]): string[] {
  const ids = new Set<string>();
  for (const el of elements) for (const id of stackFileIds(el)) ids.add(id);
  return [...ids];
}

/**
 * Every file the scene needs: image elements' `fileId`s plus extension source files. Use this
 * wherever files are filtered by reference (collab sync, PNG embedding) so originals survive.
 * Deleted elements are included; callers filter them when that matters.
 */
export function sceneFileIds(elements: readonly ExcalidrawElement[]): string[] {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el.type === "image" && el.fileId) ids.add(el.fileId);
  }
  for (const id of extensionReferencedFileIds(elements)) ids.add(id);
  return [...ids];
}

type Base = Rect & { fileId: FileId; crop: ImageCrop | null };

/** The undecorated state of `el`: its stored original (if current), else the element itself. */
function baseOf(el: ExcalidrawImageElement, read: StackRead): Base {
  if (read.kind === "ok" && read.current) {
    const src = read.stack.source;
    const b = restoreBounds(
      el,
      { width: src.appliedWidth, height: src.appliedHeight },
      { width: src.width, height: src.height },
    );
    return { fileId: src.fileId, ...b, crop: src.crop };
  }
  if (!el.fileId) throw new Error("image has no file");
  return { fileId: el.fileId, x: el.x, y: el.y, width: el.width, height: el.height, crop: el.crop };
}

function withStack(el: ExcalidrawElement, stack: ExtensionStack | null) {
  const next: Record<string, unknown> = { ...(el.customData ?? {}) };
  if (stack) next[EXT_KEY] = stack;
  else delete next[EXT_KEY];
  return Object.keys(next).length ? next : undefined;
}

function bump(el: ExcalidrawElement, patch: Partial<ExcalidrawImageElement>): ExcalidrawElement {
  return {
    ...el,
    ...patch,
    version: el.version + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  } as ExcalidrawElement;
}

export type ChainAction =
  | { kind: "apply"; params: Record<string, unknown> }
  | { kind: "remove" };

/**
 * Applies (or re-parameterises) / removes `ext` on `el`, re-rendering the original through the
 * resulting chain. Removing the last link restores the original image. A stale element is treated
 * as a fresh original; an unreadable stack is refused (it would silently drop links).
 */
export async function runChain(
  el: ExcalidrawElement,
  ext: AnyDesktopExtension,
  action: ChainAction,
  ctx: ExtensionContext,
): Promise<ExtensionResult> {
  if (el.type !== "image") throw new Error(`${ext.title} only applies to images`);
  const read = readStack(el);
  if (read.kind === "unreadable") {
    throw new Error(`this image's extensions can't be edited: ${read.reason}`);
  }
  const current = read.kind === "ok" && read.current;
  let chain = current ? read.stack.chain : [];
  if (action.kind === "apply") {
    const params = { ...(ext.normalizeParams(action.params) as Record<string, unknown>) };
    chain = canonicalChain([...chain, { ext: ext.id, v: ext.version, params }]);
  } else {
    if (!chain.some((l) => l.ext === ext.id)) throw new Error(`${ext.title} is not applied`);
    chain = chain.filter((l) => l.ext !== ext.id);
  }

  const base = baseOf(el, read);
  const original = ctx.getFile(base.fileId);
  if (!original) {
    throw new Error(
      current
        ? `the original image for ${ext.title} is missing`
        : "the image file is not available in this scene",
    );
  }

  if (!chain.length) {
    const element = bump(el, {
      fileId: base.fileId,
      x: base.x,
      y: base.y,
      width: base.width,
      height: base.height,
      crop: base.crop,
      customData: withStack(el, null),
    });
    return { element, files: [original] };
  }

  const exts = chain.map((l) => ({
    link: l,
    ext: l.ext === ext.id ? ext : getExtension(l.ext)!,
  }));
  const source = await loadSource(original);
  let plan = basePlan({
    element: base,
    crop: base.crop,
    naturalWidth: source.naturalWidth,
    naturalHeight: source.naturalHeight,
    isVector: original.mimeType === "image/svg+xml",
  });
  for (const { link, ext: e } of exts) if (e.plan) plan = e.plan(plan, link.params);

  const outId = outputFileId(base.fileId, plan, chain) as FileId;
  const steps: RenderStep[] = exts
    .filter(({ ext: e }) => e.render)
    .map(({ link, ext: e }) => (c, p) => e.render!(c, p, link.params));
  const outFile: BinaryFileData = ctx.getFile(outId) ?? {
    id: outId,
    mimeType: "image/png",
    dataURL: (await source.render(plan, steps)) as DataURL,
    created: Date.now(),
  };
  const stack: ExtensionStack = {
    v: STACK_VERSION,
    chain,
    source: {
      fileId: base.fileId,
      x: base.x,
      y: base.y,
      width: base.width,
      height: base.height,
      crop: base.crop,
      appliedWidth: plan.element.width,
      appliedHeight: plan.element.height,
    },
    outputFileId: outId,
  };
  const element = bump(el, {
    ...plan.element,
    fileId: outId,
    crop: null,
    customData: withStack(el, stack),
  });
  return { element, files: [outFile] };
}
