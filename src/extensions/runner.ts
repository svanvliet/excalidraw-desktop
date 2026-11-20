/**
 * Apply / remove an extension on scene elements (docs/extensions.md § Runner).
 *
 * Two phases, so the (async) extension work never races a synchronous scene write:
 *  1. `prepareExtension` runs the extension against a snapshot of the scene and records each
 *     element's `version` at that moment.
 *  2. `mergePrepared` (UI) or `applyPreparedToDraft` (agent) writes the results through
 *     `newElementWith` — only for elements still at the recorded version; anything edited in
 *     between is reported as a conflict and left alone.
 * `runExtension` is the UI entry point: one `updateScene` with `IMMEDIATELY` = one undo step;
 * collaborators receive it like any other local edit.
 */
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { SceneApi } from "../agent/sceneBridge";
import { log } from "../lib/logger";
import { getExtension, intentFileIds } from "./registry";
import { validateSchema } from "./schema";
import type { AnyDesktopExtension, ExtensionContext } from "./types";

type El = ExcalidrawElement;

export type ExtensionAction =
  | { kind: "apply"; params: Record<string, unknown> }
  | { kind: "remove" };

export interface PreparedEdit {
  id: string;
  /** Element version the extension ran against. */
  baseVersion: number;
  element: El;
  files: BinaryFileData[];
}

export interface Skipped {
  id: string;
  reason: string;
}

export interface Prepared {
  ext: AnyDesktopExtension;
  edits: PreparedEdit[];
  skipped: Skipped[];
}

/** Bad extension id / params — the whole request is invalid. */
export class ExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionError";
  }
}

export function resolveExtension(id: unknown): AnyDesktopExtension {
  const ext = typeof id === "string" ? getExtension(id) : undefined;
  if (!ext) throw new ExtensionError(`Unknown extension ${JSON.stringify(id)}`);
  return ext;
}

/** Resolve `{preset?, params?}` to validated params (preset params, overridden by `params`). */
export function resolveParams(
  ext: AnyDesktopExtension,
  preset: unknown,
  params: unknown,
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (preset !== undefined && preset !== null) {
    const p = ext.presets.find((x) => x.id === preset);
    if (!p) {
      throw new ExtensionError(
        `Unknown ${ext.id} preset ${JSON.stringify(preset)} (presets: ${ext.presets.map((x) => x.id).join(", ")})`,
      );
    }
    base = { ...(p.params as Record<string, unknown>) };
  } else if (params === undefined || params === null) {
    throw new ExtensionError(`Pass "preset" or "params" for ${ext.id}`);
  }
  if (params !== undefined && params !== null) {
    if (typeof params !== "object" || Array.isArray(params)) {
      throw new ExtensionError(`"params" must be an object`);
    }
    base = { ...base, ...(params as Record<string, unknown>) };
  }
  const err = validateSchema(ext.paramsSchema, base);
  if (err) throw new ExtensionError(`${ext.id}: ${err}`);
  return base;
}

export function contextFor(files: BinaryFiles): ExtensionContext {
  return { getFile: (id: FileId) => files[id] };
}

/** Phase 1: run the extension (async) for each target against a scene snapshot. */
export async function prepareExtension(
  elements: readonly El[],
  files: BinaryFiles,
  ids: readonly string[],
  ext: AnyDesktopExtension,
  action: ExtensionAction,
): Promise<Prepared> {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const ctx = contextFor(files);
  const edits: PreparedEdit[] = [];
  const skipped: Skipped[] = [];
  for (const id of new Set(ids)) {
    const el = byId.get(id);
    if (!el || el.isDeleted) {
      skipped.push({ id, reason: "not found" });
      continue;
    }
    if (!ext.appliesTo(el)) {
      skipped.push({ id, reason: `${ext.title} does not apply to a ${el.type}` });
      continue;
    }
    if (action.kind === "remove" && !ext.getIntent(el)) {
      skipped.push({ id, reason: `${ext.title} is not applied` });
      continue;
    }
    const intent = ext.getIntent(el);
    if (intent && intentFileIds(intent).some((f) => !files[f])) {
      // Re-applying and removing both re-derive from the original, which this copy of the
      // drawing no longer has (e.g. it was saved by stock Excalidraw, which drops unused files).
      skipped.push({ id, reason: `the original image for ${ext.title} is missing` });
      continue;
    }
    try {
      const res =
        action.kind === "apply"
          ? await ext.apply(el, action.params, ctx)
          : await ext.remove(el, ctx);
      if (res.element.id !== el.id) throw new Error("extension returned a different element id");
      edits.push({ id, baseVersion: el.version, element: res.element, files: res.files });
    } catch (err) {
      log.warn(`extensions: ${ext.id} ${action.kind} failed on ${id}`, err);
      skipped.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ext, edits, skipped };
}

const RESERVED = ["id", "version", "versionNonce", "updated", "index"] as const;

/** The fields an extension result changes, minus bookkeeping `newElementWith` owns. */
export function fieldsOf(el: El): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...el };
  for (const k of RESERVED) delete fields[k];
  return fields;
}

export interface Merged {
  elements: El[];
  applied: string[];
  conflicts: string[];
  files: BinaryFileData[];
}

/** Phase 2 (UI): write prepared results into the current element array. */
export function mergePrepared(current: readonly El[], edits: readonly PreparedEdit[]): Merged {
  const byEdit = new Map(edits.map((e) => [e.id, e]));
  const applied: string[] = [];
  const conflicts: string[] = [];
  const files: BinaryFileData[] = [];
  const elements = current.map((el) => {
    const edit = byEdit.get(el.id);
    if (!edit) return el;
    if (el.version !== edit.baseVersion || el.isDeleted) {
      conflicts.push(el.id);
      return el;
    }
    applied.push(el.id);
    files.push(...edit.files);
    return newElementWith(el, fieldsOf(edit.element) as never, true);
  });
  for (const id of byEdit.keys()) {
    if (!applied.includes(id) && !conflicts.includes(id)) conflicts.push(id);
  }
  return { elements, applied, conflicts, files };
}

export interface RunResult {
  applied: string[];
  skipped: Skipped[];
}

/** UI entry point: apply/remove on `ids` as one undoable scene change. */
export async function runExtension(
  api: Pick<SceneApi, "getSceneElementsIncludingDeleted" | "getFiles" | "updateScene" | "addFiles">,
  ids: readonly string[],
  extId: string,
  action: ExtensionAction,
): Promise<RunResult> {
  const ext = resolveExtension(extId);
  if (action.kind === "apply") {
    const err = validateSchema(ext.paramsSchema, action.params);
    if (err) throw new ExtensionError(`${ext.id}: ${err}`);
  }
  const prepared = await prepareExtension(
    api.getSceneElementsIncludingDeleted(),
    api.getFiles(),
    ids,
    ext,
    action,
  );
  const merged = mergePrepared(api.getSceneElementsIncludingDeleted(), prepared.edits);
  const skipped = [
    ...prepared.skipped,
    ...merged.conflicts.map((id) => ({ id, reason: "changed while the extension ran" })),
  ];
  if (merged.applied.length) {
    if (merged.files.length) api.addFiles(merged.files);
    api.updateScene({
      elements: merged.elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
  return { applied: merged.applied, skipped };
}
