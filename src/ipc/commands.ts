/**
 * Typed wrappers over `@tauri-apps/api/core`'s `invoke()`.
 *
 * Per CLAUDE.md §3, components never call `invoke()` directly — they go through
 * the functions in this module so the contract with Rust is enforced by the
 * TS type system.
 *
 * When the bundle runs **outside** the Tauri shell (e.g. `vite preview` for
 * Playwright smoke tests, or a misconfigured dev env), every wrapper
 * resolves to a safe degraded value instead of throwing. This keeps the
 * web preview usable for E2E without polluting production code paths.
 */
import { invoke } from "@tauri-apps/api/core";

/** True iff we're running inside a Tauri webview. */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI_IPC__);
}

function unavailable(command: string): never {
  throw {
    kind: "other",
    message: `IPC command '${command}' is unavailable outside the Tauri runtime`,
  } satisfies AppError;
}

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
  if (!isTauri()) return Promise.reject(unavailable("open_file"));
  return invoke<OpenedFile>("open_file", { path });
}

/** Write `contents` to `path`, replacing the existing file. */
export function saveFile(path: string, contents: string): Promise<void> {
  if (!isTauri()) return Promise.reject(unavailable("save_file"));
  return invoke<void>("save_file", { path, contents });
}

/** Mirror of the Rust `ReadBytesResult` struct in `src-tauri/src/commands/files.rs`. */
export interface ReadBytesResult {
  path: string;
  /** base64-encoded file contents. */
  base64: string;
}

/** Read a binary file from disk and return base64-encoded bytes. */
export function readFileBytes(path: string): Promise<ReadBytesResult> {
  if (!isTauri()) return Promise.reject(unavailable("read_file_bytes"));
  return invoke<ReadBytesResult>("read_file_bytes", { path });
}

/** Write base64-encoded bytes to disk, replacing any existing file. */
export function writeFileBytes(path: string, base64Contents: string): Promise<void> {
  if (!isTauri()) return Promise.reject(unavailable("write_file_bytes"));
  return invoke<void>("write_file_bytes", { path, base64Contents });
}

/** Mirror of the Rust `ScratchEntry` struct in `src-tauri/src/commands/scratch.rs`. */
export interface ScratchEntry {
  key: string;
  contents: string;
}

/** Persist `contents` to the OS app-data scratch dir keyed by `key`. */
export function writeScratch(key: string, contents: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke<void>("write_scratch", { key, contents });
}

/** Read the scratch entry for `key`, or `null` if none exists. */
export async function readScratch(key: string): Promise<string | null> {
  if (!isTauri()) return null;
  const result = await invoke<string | null>("read_scratch", { key });
  return result ?? null;
}

/** Delete the scratch entry for `key`. No-op if missing. */
export function deleteScratch(key: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke<void>("delete_scratch", { key });
}

/** List every scratch entry currently on disk. */
export function listScratch(): Promise<ScratchEntry[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke<ScratchEntry[]>("list_scratch");
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
