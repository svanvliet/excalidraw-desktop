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
import type {
  AgentStartOptions,
  EngineInfo,
  EngineOverride,
  PermissionDecision,
  ToolCallResult,
} from "../agent/types";

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

// ---------------------------------------------------------------------------
// Live collaboration (see docs/collab-protocol.md §5)
// ---------------------------------------------------------------------------

export type TunnelMode = "auto" | "manual" | "local";

export interface CollabStartArgs {
  roomId: string;
  port: number;
  tunnel: TunnelMode;
  manualUrl?: string;
}

export interface CollabStatus {
  running: boolean;
  roomId: string | null;
  localPort: number | null;
  localBase: string | null;
  publicBase: string | null;
  tunnel: {
    mode: TunnelMode | null;
    state: "off" | "starting" | "ready" | "error";
    error: string | null;
  };
  peerCount: number;
  /** Sent in the host webview's `join` so the relay grants it the host role. */
  hostToken: string | null;
}

export const COLLAB_STATUS_EVENT = "collab://status";

export const COLLAB_STATUS_OFF: CollabStatus = {
  running: false,
  roomId: null,
  localPort: null,
  localBase: null,
  publicBase: null,
  tunnel: { mode: null, state: "off", error: null },
  peerCount: 0,
  hostToken: null,
};

/** Start the local relay, register `roomId`, and (optionally) a tunnel. */
export function collabStart(args: CollabStartArgs): Promise<CollabStatus> {
  if (!isTauri()) return Promise.reject(unavailable("collab_start"));
  return invoke<CollabStatus>("collab_start", { args });
}

/** End the session: closes peers (code 4000), stops tunnel + relay. */
export function collabStop(): Promise<CollabStatus> {
  if (!isTauri()) return Promise.resolve(COLLAB_STATUS_OFF);
  return invoke<CollabStatus>("collab_stop");
}

/** Disconnect one peer from the hosted room (close 4001). */
export function collabRemovePeer(clientId: string): Promise<void> {
  if (!isTauri()) return Promise.reject(unavailable("collab_remove_peer"));
  return invoke<void>("collab_remove_peer", { clientId });
}

/** Make a guest an editor or a viewer in the active room. */
export function collabSetRole(clientId: string, role: "editor" | "viewer"): Promise<void> {
  if (!isTauri()) return Promise.reject(unavailable("collab_set_role"));
  return invoke<void>("collab_set_role", { clientId, role });
}

export function collabStatus(): Promise<CollabStatus> {
  if (!isTauri()) return Promise.resolve(COLLAB_STATUS_OFF);
  return invoke<CollabStatus>("collab_status");
}

/** Test-profile name (`--profile` / `EXCALIDRAW_DESKTOP_PROFILE`), or null. */
export async function appProfile(): Promise<string | null> {
  if (!isTauri()) return null;
  return (await invoke<string | null>("app_profile")) ?? null;
}

// ---------- OS integration (src-tauri/src/commands/system.rs) ----------

/**
 * Tell Rust the file-open listener is attached; returns paths the OS asked
 * to open before that (e.g. a Finder double-click that launched the app).
 */
export async function fileOpenReady(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("file_open_ready");
}

export interface RecentMenuItem {
  path: string;
  label: string;
}

/** Rebuild the native File → Open Recent submenu. */
export async function setRecentMenu(items: RecentMenuItem[]): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("set_recent_menu", { items });
}

/** The OS user's full name (or login name); "" when unknown. */
export async function osUserName(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("os_user_name");
}

// ---------- Updates (src-tauri/src/updater.rs) ----------

export type UpdateStatusKind =
  | "idle"
  | "checking"
  | "upToDate"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UpdateState {
  status: UpdateStatusKind;
  currentVersion: string;
  version: string | null;
  notes: string | null;
  progress: number | null;
  error: string | null;
  lastChecked: string | null;
  /** False in dev builds and the web preview. */
  enabled: boolean;
}

/** Mirror of `updater::UPDATE_STATUS_EVENT`. */
export const UPDATE_STATUS_EVENT = "excalidraw://update-status";

export const UPDATE_STATE_UNAVAILABLE: UpdateState = {
  status: "idle",
  currentVersion: "",
  version: null,
  notes: null,
  progress: null,
  error: null,
  lastChecked: null,
  enabled: false,
};

export function updateStatus(): Promise<UpdateState> {
  if (!isTauri()) return Promise.resolve(UPDATE_STATE_UNAVAILABLE);
  return invoke<UpdateState>("update_status");
}

/** Check GitHub Releases and download a newer version in the background. */
export function updateCheck(manual: boolean): Promise<UpdateState> {
  if (!isTauri()) return Promise.resolve(UPDATE_STATE_UNAVAILABLE);
  return invoke<UpdateState>("update_check", { manual });
}

/** Install the downloaded update and restart the app. */
export function updateInstall(): Promise<void> {
  if (!isTauri()) return Promise.reject(unavailable("update_install"));
  return invoke<void>("update_install");
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

// ---------------------------------------------------------------------------
// AI agent (docs/ai-integration.md). Mirrors `src-tauri/src/commands/agent.rs`.
// ---------------------------------------------------------------------------

export const AGENT_EVENT = "agent://event";
export const AGENT_TOOL_CALL_EVENT = "agent://tool-call";

/** Probe installed engines (binary, version, login). Never runs a model turn. */
export function agentDetect(overrides: EngineOverride[] = []): Promise<EngineInfo[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke<EngineInfo[]>("agent_detect", { overrides });
}

/** Start an engine session for a tab; resolves to the app session id. */
export function agentStart(options: AgentStartOptions): Promise<string> {
  if (!isTauri()) return Promise.reject(unavailable("agent_start"));
  return invoke<string>("agent_start", { options });
}

/** Send a prompt; resolves to the turn id. Progress arrives on `agent://event`. */
export function agentPrompt(sessionId: string, text: string): Promise<string> {
  if (!isTauri()) return Promise.reject(unavailable("agent_prompt"));
  return invoke<string>("agent_prompt", { sessionId, text });
}

export function agentCancel(sessionId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke<void>("agent_cancel", { sessionId });
}

export function agentPermissionRespond(
  sessionId: string,
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  if (!isTauri()) return Promise.reject(unavailable("agent_permission_respond"));
  return invoke<void>("agent_permission_respond", { sessionId, requestId, decision });
}

export function agentStop(sessionId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke<void>("agent_stop", { sessionId });
}

/** Return a canvas tool result to the MCP server. */
export function agentToolResult(result: ToolCallResult): Promise<void> {
  if (!isTauri()) return Promise.reject(unavailable("agent_tool_result"));
  return invoke<void>("agent_tool_result", { result });
}
