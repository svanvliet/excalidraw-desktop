/**
 * MCP tool definitions generated from the extension registry (docs/extensions.md § Agent tools).
 * src/agent/tools.json must contain exactly these entries — tools.test.ts fails when it drifts;
 * `npm run extensions:sync-tools` rewrites them.
 */
import type { CanvasToolDef } from "../agent/types";
import type { AnyDesktopExtension } from "./types";

export const EXTENSION_TOOL_NAMES = ["apply_extension", "remove_extension"] as const;

const ids = {
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: 200,
};

function catalogLine(ext: AnyDesktopExtension): string {
  const presets = ext.presets.map((p) => `${p.id} (${p.label})`).join(", ");
  return `${ext.id}: ${ext.description ?? ext.title}${presets ? `; presets ${presets}` : ""}.`;
}

export function extensionToolDefs(list: readonly AnyDesktopExtension[]): CanvasToolDef[] {
  const extIds = list.map((e) => e.id);
  const presetIds = [...new Set(list.flatMap((e) => e.presets.map((p) => p.id)))];
  const extension: Record<string, unknown> = { type: "string" };
  if (extIds.length) extension.enum = extIds;
  const preset: Record<string, unknown> = {
    type: "string",
    description: "A preset of the chosen extension (the same actions the app UI offers).",
  };
  if (presetIds.length) preset.enum = presetIds;
  const params: Record<string, unknown> = {
    type: "object",
    description:
      "Extension parameters; merged over the preset's params when both are given. Schema per extension below.",
  };
  if (list.length) params.anyOf = list.map((e) => ({ title: e.id, ...e.paramsSchema }));
  const catalog = list.length
    ? ` Extensions: ${list.map(catalogLine).join(" ")}`
    : " No extensions are installed.";
  const order = list.length ? list.map((e) => e.id).join(" → ") : "none";
  const common = `Built-in app extensions store their settings in the element's customData and write standard Excalidraw output (ordinary element fields and image files), so the file still renders in stock Excalidraw. Extensions on one element stack in a fixed order (${order}); every change re-renders the original through the whole stack, so e.g. a border follows the current mask shape. get_scene_summary rows show applied extensions as ext and edited-elsewhere ones as extStale.`;
  return [
    {
      name: "apply_extension",
      readOnly: false,
      description: `Apply (or re-apply with new params) an extension to elements, as one undoable change. ${common} Applying one extension keeps the others; re-applying replaces its params. Elements it doesn't apply to are returned in skipped.${catalog} Pass expectedRevision (from the last read) to fail instead of overwriting concurrent changes.`,
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          expectedRevision: { type: "string" },
          ids,
          extension,
          preset,
          params,
        },
        required: ["ids", "extension"],
        additionalProperties: false,
      },
    },
    {
      name: "remove_extension",
      readOnly: false,
      description: `Remove one extension from elements, keeping the others (removing the last restores the original image), as one undoable change. ${common} Elements where it isn't applied (or is stale) are returned in skipped and left alone. Pass expectedRevision (from the last read) to fail instead of overwriting concurrent changes.`,
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          expectedRevision: { type: "string" },
          ids,
          extension,
        },
        required: ["ids", "extension"],
        additionalProperties: false,
      },
    },
  ];
}
