/**
 * Contract for built-in desktop extensions (docs/extensions.md).
 *
 * Extensions are stages of an image pipeline. An element carries an ordered *chain* of extension
 * links plus one recorded original (`source`) in `element.customData[EXT_KEY]` (persisted in
 * `.excalidraw`, ignored by stock Excalidraw). Applying, re-parameterising or removing any link
 * re-renders the original through the whole chain into one standard PNG `BinaryFile`
 * (`outputFileId`), so the scene renders identically anywhere. The same definition drives the app
 * UI (presets / choices) and the agent's MCP tools (`paramsSchema`).
 */
import type { ExcalidrawElement, FileId, ImageCrop } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ImagePlan } from "./pipeline";

/** `element.customData[EXT_KEY]` holds the {@link ExtensionStack}. */
export const EXT_KEY = "excalidrawDesktop";

/** Storage format of {@link ExtensionStack} (v1 was a single-extension object, see stack.ts). */
export const STACK_VERSION = 2;

/**
 * Canonical chain order: links run by ascending `stage`. Shape stages change the outline (and
 * possibly bounds) that decorations then trace.
 */
export const STAGE = { shape: 100, decoration: 200 } as const;

/** One applied extension within a chain. */
export type ExtensionLink = {
  /** Extension id, e.g. "mask". */
  ext: string;
  /** That extension's schema version when the link was written. */
  v: number;
  /** Normalized params. */
  params: Record<string, unknown>;
};

/** The original image the chain renders from, plus what's needed to restore it. */
export type StackSource = {
  fileId: FileId;
  x: number;
  y: number;
  width: number;
  height: number;
  crop: ImageCrop | null;
  /** Element size right after rendering; used to carry later resizes back on restore. */
  appliedWidth: number;
  appliedHeight: number;
};

export type ExtensionStack = {
  v: typeof STACK_VERSION;
  /** Sorted by stage; at most one link per extension. */
  chain: ExtensionLink[];
  /**
   * Files the stack depends on MUST be named `source.fileId` or `source.fileIds` so the app keeps
   * them in saves and collab sync (see `sceneFileIds`).
   */
  source: StackSource;
  /** The output file the chain produced; a different `fileId` on the element means stale. */
  outputFileId: FileId;
};

export interface ExtensionContext {
  getFile(id: FileId): BinaryFileData | undefined;
}

export interface ExtensionResult {
  /** Same id, updated (customData set/cleared). */
  element: ExcalidrawElement;
  /** Files to register via `addFiles`. */
  files: BinaryFileData[];
}

export interface ExtensionPreset<P> {
  id: string;
  label: string;
  /** May be partial; missing params take their defaults (or carry over, see `choices`). */
  params: Partial<P>;
}

/** Quick picks for one param, shown after the presets (e.g. border colour swatches). */
export interface ExtensionChoices {
  param: string;
  label: string;
  options: { value: string | number; label: string; /** CSS colour for a swatch. */ swatch?: string }[];
}

/** Canvas API stages may draw with (a CanvasRenderingContext2D). */
export type RenderTarget = CanvasRenderingContext2D;

export interface DesktopExtension<P = Record<string, unknown>> {
  id: string;
  /** Schema version written to each link's `v`; links with a newer `v` are unreadable. */
  version: number;
  /** Chain position (see {@link STAGE}). */
  stage: number;
  /** Human title, e.g. "Mask". */
  title: string;
  /** Optional one-line description for tooltips and the agent (falls back to `title`). */
  description?: string;
  appliesTo(el: ExcalidrawElement): boolean;
  /** JSON Schema for `params` (embedded in the MCP tool schemas). */
  paramsSchema: Record<string, unknown>;
  /** UI actions, e.g. Circle. Also the agent's `preset` ids. */
  presets: ExtensionPreset<P>[];
  /** Preset used as the base when a choice is picked on an element without this extension. */
  defaultPreset?: string;
  choices?: ExtensionChoices;
  /** Validates unknown input and fills defaults. Throws a user-readable Error. */
  normalizeParams(input: unknown): P;
  /** Upgrades params stored by an older `version` (before `normalizeParams`). */
  migrateParams?(params: Record<string, unknown>, fromVersion: number): Record<string, unknown>;
  /** Pure geometry: transform the plan (bounds, visible source, output size, outline). */
  plan?(plan: ImagePlan, params: P): ImagePlan;
  /**
   * Draw onto the output after the source image (and earlier stages) were drawn. The pipeline
   * clips the result to `plan.outline` afterwards, so drawing past the outline is fine.
   */
  render?(ctx: RenderTarget, plan: ImagePlan, params: P): void;
}

/** Registry-erased form (params are validated against `paramsSchema` before use). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDesktopExtension = DesktopExtension<any>;
