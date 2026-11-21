/**
 * AI agent contract types. Mirrors `src-tauri/src/agent/events.rs`, `detect.rs`, and
 * `commands/agent.rs` — keep in sync (shared contract; change only with conductor sign-off).
 * Design: docs/ai-integration.md.
 */
import toolsContract from "./tools.json";

export type EngineKind = "copilot" | "claude" | "codex";

export type ErrorKind =
  | "notInstalled"
  | "notLoggedIn"
  | "orgDisabled"
  | "unsupportedVersion"
  | "quotaExceeded"
  | "crashed"
  | "protocol"
  | "timeout"
  | "other";

export type StopReason = "endTurn" | "cancelled" | "maxTurns" | "refusal" | "error";
export type ToolCallStatus = "pending" | "running" | "completed" | "failed";
export type ToolSource = "canvas" | "host" | "builtin";
export type PermissionDecision = "allowOnce" | "allowForConversation" | "allowAll" | "deny";

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  premiumRequests: number | null;
}

export interface PlanEntry {
  content: string;
  status: string;
}

export type AgentEvent =
  | {
      type: "ready";
      engine: EngineKind;
      version: string | null;
      model: string | null;
      engineSessionId: string | null;
    }
  | { type: "models"; available: ModelOption[] }
  | { type: "modelChanged"; model: string }
  | { type: "turnStarted"; turnId: string }
  | { type: "textDelta"; turnId: string; text: string }
  | { type: "thinkingDelta"; turnId: string; text: string }
  | {
      type: "toolCall";
      turnId: string;
      callId: string;
      name: string;
      title: string | null;
      source: ToolSource;
      status: ToolCallStatus;
      input: unknown;
      output: string | null;
    }
  | {
      type: "permissionRequest";
      turnId: string;
      requestId: string;
      toolName: string;
      title: string;
      detail: string | null;
    }
  | { type: "plan"; turnId: string; entries: PlanEntry[] }
  /** The conversation's "allow all" approval mode changed (D-AI4). */
  | { type: "approvalMode"; allowAll: boolean }
  | { type: "turnEnded"; turnId: string; stopReason: StopReason; usage: Usage | null }
  | { type: "error"; kind: ErrorKind; message: string; fatal: boolean }
  | { type: "exited"; code: number | null };

/** One selectable model as the engine lists it. */
export interface ModelOption {
  id: string;
  name: string | null;
}

export interface AgentEventEnvelope {
  sessionId: string;
  tabId: string;
  event: AgentEvent;
}

export interface ToolCallRequest {
  callId: string;
  sessionId: string;
  tabId: string;
  tool: CanvasToolName;
  args: Record<string, unknown>;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolCallResult {
  callId: string;
  isError: boolean;
  content: ToolContent[];
}

export type EngineStatus = "ready" | "notFound" | "notLoggedIn" | "unsupportedVersion" | "unknown";

export interface EngineInfo {
  engine: EngineKind;
  status: EngineStatus;
  path: string | null;
  version: string | null;
  minVersion: string;
  message: string | null;
}

export interface EngineOverride {
  engine: EngineKind;
  path: string | null;
}

export interface AgentStartOptions {
  tabId: string;
  engine: EngineKind;
  pathOverride: string | null;
  useHostConfig: boolean;
  model: string | null;
  attachedFolder: string | null;
  resumeId: string | null;
  /** App-side conversation id; gives each conversation a stable scratch cwd. */
  conversationId?: string | null;
  /**
   * The folder was attached after the conversation started: keep the session folder as
   * the cwd (engines tie resume to it) and add the folder as a second writable root.
   */
  keepSessionCwd?: boolean;
}

export const CANVAS_TOOL_NAMES = [
  "list_tabs",
  "get_scene_summary",
  "get_selection",
  "get_elements",
  "render_canvas_png",
  "add_elements",
  "update_elements",
  "delete_elements",
  "connect",
  "add_mermaid",
  "add_image",
  "arrange",
  "set_viewport",
  "find_elements",
  "select_elements",
  "get_canvas_state",
  "move_elements",
  "duplicate_elements",
  "set_canvas",
  "auto_layout",
  "tidy_arrows",
  "apply_ops",
  "apply_extension",
  "remove_extension",
  "list_layers",
  "update_layer",
  "set_shape_data",
  "set_arrow_anchors",
  "get_shape_data",
  "create_component",
  "insert_instance",
  "list_components",
  "list_my_components",
  "insert_my_component",
  "set_overrides",
  "reset_overrides",
  "detach_instance",
  "define_property",
  "remove_property",
  "set_properties",
  "create_container",
  "update_container",
  "remove_container",
  "add_to_container",
  "remove_from_container",
  "list_containers",
  "list_styles",
  "create_style",
  "apply_style",
  "update_style",
  "delete_style",
  "reset_style_overrides",
] as const;
export type CanvasToolName = (typeof CANVAS_TOOL_NAMES)[number];

export interface CanvasToolDef {
  name: string;
  readOnly: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const CANVAS_TOOLS: CanvasToolDef[] = toolsContract.tools as CanvasToolDef[];
