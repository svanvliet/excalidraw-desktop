/**
 * Typed wrappers over `@tauri-apps/api/core`'s `invoke()`.
 *
 * Per CLAUDE.md §3, components never call `invoke()` directly — they go through
 * the functions in this module so the contract with Rust is enforced by the
 * TS type system.
 */
import { invoke } from "@tauri-apps/api/core";

/** Mirror of the Rust `OpenedFile` struct in `src-tauri/src/commands/files.rs`. */
export interface OpenedFile {
  path: string;
  contents: string;
}

/** Mirror of the Rust `SerializedAppError` enum in `src-tauri/src/error.rs`. */
export type AppError =
  | { kind: "io"; path: string; message: string }
  | { kind: "invalid_file"; message: string }
  | { kind: "other"; message: string };

/** Read a UTF-8 file from disk by absolute path. */
export function openFile(path: string): Promise<OpenedFile> {
  return invoke<OpenedFile>("open_file", { path });
}

/** Write `contents` to `path`, replacing the existing file. */
export function saveFile(path: string, contents: string): Promise<void> {
  return invoke<void>("save_file", { path, contents });
}

/**
 * Type guard for the shaped error coming back from a failed `invoke`.
 * Tauri rejects with the serialized form when a command returns `Err(...)`.
 */
export function isAppError(value: unknown): value is AppError {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.kind === "string" &&
    ["io", "invalid_file", "other"].includes(record.kind) &&
    typeof record.message === "string"
  );
}
