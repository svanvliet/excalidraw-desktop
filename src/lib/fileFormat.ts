/**
 * Helpers for detecting and parsing Excalidraw file formats.
 *
 * The native Excalidraw format is JSON with a `type: "excalidraw"` discriminator.
 * Excalidraw can also embed the scene inside a PNG (via a tEXt/iTXt chunk):
 * - On read we detect the magic bytes and let the upstream `loadFromBlob`
 *   helper extract the scene.
 * - On write we use Excalidraw's `exportToBlob({ embedScene: true })`.
 */

/** Minimal shape we care about when validating an Excalidraw JSON file. */
export interface ExcalidrawFile {
  type: "excalidraw";
  version: number;
  source?: string;
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export type FileFormatKind = "excalidraw-json" | "unknown";

export interface DetectedFormat {
  kind: FileFormatKind;
  /** When `kind === "excalidraw-json"`, the parsed object. */
  parsed?: ExcalidrawFile;
  /** When the format could not be identified, a human-readable reason. */
  reason?: string;
}

/**
 * Identify what kind of Excalidraw file the given UTF-8 string is.
 *
 * Conservative on purpose: a JSON parse failure or a missing `type` discriminator
 * is treated as `unknown` rather than thrown.
 */
export function detectFormat(contents: string): DetectedFormat {
  const trimmed = contents.trimStart();
  if (!trimmed.startsWith("{")) {
    return { kind: "unknown", reason: "not a JSON object" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (e) {
    return { kind: "unknown", reason: `invalid JSON: ${(e as Error).message}` };
  }
  if (!isExcalidrawFile(parsed)) {
    return { kind: "unknown", reason: "missing excalidraw discriminator" };
  }
  return { kind: "excalidraw-json", parsed };
}

/** Type guard for the Excalidraw JSON shape. */
export function isExcalidrawFile(value: unknown): value is ExcalidrawFile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "excalidraw" &&
    typeof record.version === "number" &&
    Array.isArray(record.elements)
  );
}

/**
 * Serialize an Excalidraw scene to the canonical `.excalidraw` JSON shape.
 * Mirrors what `serializeAsJSON` in `@excalidraw/excalidraw` produces, but keeps us
 * decoupled from its export surface for things like dirty-tracking and tests.
 *
 * Strips runtime-only keys from `appState` (see `excalidrawRestore.ts`) so
 * we don't write a `collaborators: {}` (Map-flattened-by-JSON) into the
 * saved file — which would only be recovered on read via `restore()`.
 * Save-side sanitization keeps the on-disk format clean too.
 */
export function serializeScene(
  elements: readonly unknown[],
  appState: Record<string, unknown> = {},
  files: Record<string, unknown> = {},
): string {
  const document: ExcalidrawFile = {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-desktop",
    elements: [...elements],
    appState: sanitizeAppStateForExport(appState),
    files,
  };
  return JSON.stringify(document, null, 2);
}

/**
 * Same key list as `sanitizeImportedAppState` (kept in `excalidrawRestore.ts`
 * for centralization) — duplicated here as a small private constant to
 * avoid a circular import between fileFormat (used by everything) and
 * excalidrawRestore (which depends on Excalidraw). If you add a runtime
 * key, update both.
 */
const RUNTIME_ONLY_APPSTATE_KEYS = new Set([
  "collaborators",
  "selectedElementsAreBeingDragged",
  "isResizing",
  "isRotating",
  "isLoading",
  "errorMessage",
  "draggingElement",
  "editingElement",
  "resizingElement",
  "multiElement",
  "selectionElement",
  "newElement",
  "editingTextElement",
  "snapLines",
  "originSnapOffset",
  "contextMenu",
  "showWelcomeScreen",
  "toast",
  "pasteDialog",
  "pendingImageElementId",
]);

function sanitizeAppStateForExport(appState: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(appState)) {
    if (!RUNTIME_ONLY_APPSTATE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/** PNG magic bytes — first 8 bytes of every PNG file. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True if `bytes` begins with the PNG signature. */
export function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

/** Decode standard base64 into a Uint8Array. Works in jsdom. */
export function base64ToBytes(b64: string): Uint8Array {
  // atob is available in browser + jsdom environments.
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encode a Uint8Array into a standard base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // chunked to avoid call-stack overflow on large buffers
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[]);
  }
  return btoa(binary);
}

/** Pick the file format based on its path extension. Defaults to JSON. */
export function formatFromExtension(path: string): "png" | "json" {
  const lower = path.toLowerCase();
  return lower.endsWith(".png") ? "png" : "json";
}
