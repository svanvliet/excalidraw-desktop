/**
 * Helpers for detecting and parsing Excalidraw file formats.
 *
 * The native Excalidraw format is JSON with a `type: "excalidraw"` discriminator.
 * In M4 we'll also detect PNG-with-embedded-scene; for now we only deal with JSON.
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
    appState,
    files,
  };
  return JSON.stringify(document, null, 2);
}
