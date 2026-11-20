/**
 * Agent side of the extension runner (src/extensions/runner.ts): `apply_extension` /
 * `remove_extension` are prepared (async) before the draft exists, then written into the draft
 * synchronously so they commit with the rest of the tool call or `apply_ops` batch.
 */
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import {
  ExtensionError,
  fieldsOf,
  prepareExtension,
  resolveExtension,
  resolveParams,
  type Prepared,
} from "../../extensions/runner";
import { type Draft, type El, ToolError } from "./draft";

type Args = Record<string, unknown>;

export const EXTENSION_TOOLS: ReadonlySet<string> = new Set([
  "apply_extension",
  "remove_extension",
]);

function idsOf(args: Args): string[] {
  const v = args.ids;
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string")) {
    throw new ToolError(`"ids" must be a non-empty array of element id strings`);
  }
  if (v.length > 200) throw new ToolError(`At most 200 ids per call`);
  return v as string[];
}

/** Phase 1: validate and run the extension against the current scene. */
export async function prepareExtensionTool(
  tool: string,
  args: Args,
  elements: readonly El[],
  files: BinaryFiles,
): Promise<Prepared> {
  try {
    const ext = resolveExtension(args.extension);
    const action =
      tool === "apply_extension"
        ? { kind: "apply" as const, params: resolveParams(ext, args.preset, args.params) }
        : { kind: "remove" as const };
    return await prepareExtension(elements, files, idsOf(args), ext, action);
  } catch (err) {
    if (err instanceof ExtensionError) throw new ToolError(err.message);
    throw err;
  }
}

/** Phase 2: write prepared results into the draft; files go to `outFiles` for the commit. */
export function applyPreparedToDraft(
  draft: Draft,
  prepared: Prepared,
  outFiles: BinaryFileData[],
): { extension: string; applied: string[]; skipped?: Array<{ id: string; reason: string }> } {
  const applied: string[] = [];
  for (const edit of prepared.edits) {
    const cur = draft.get(edit.id);
    if (!cur || cur.version !== edit.baseVersion) {
      throw new ToolError(
        `Element "${edit.id}" changed before ${prepared.ext.title} could be applied ` +
          "(apply extensions in a separate call from other edits to the same element); retry.",
      );
    }
    draft.update(edit.id, fieldsOf(edit.element), true);
    outFiles.push(...edit.files);
    applied.push(edit.id);
  }
  if (!applied.length) {
    const why = prepared.skipped.map((s) => `${s.id}: ${s.reason}`).join("; ");
    throw new ToolError(`${prepared.ext.title} changed nothing (${why || "no targets"})`);
  }
  return {
    extension: prepared.ext.id,
    applied,
    ...(prepared.skipped.length ? { skipped: prepared.skipped } : {}),
  };
}
