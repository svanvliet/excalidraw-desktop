//! Canonical agent event model. Every engine adapter translates its protocol into these
//! events; the webview only ever sees these. Mirrored in `src/agent/types.ts` — keep in sync.
use serde::{Deserialize, Serialize};

/// Tauri event carrying [`AgentEventEnvelope`] to the webview.
pub const AGENT_EVENT: &str = "agent://event";
/// Tauri event carrying [`ToolCallRequest`] to the webview scene-tool executor.
pub const AGENT_TOOL_CALL_EVENT: &str = "agent://tool-call";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    Copilot,
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    NotInstalled,
    NotLoggedIn,
    OrgDisabled,
    UnsupportedVersion,
    QuotaExceeded,
    Crashed,
    Protocol,
    Timeout,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    EndTurn,
    Cancelled,
    MaxTurns,
    Refusal,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolCallStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

/// Where a tool comes from. `Canvas` = our own MCP tools (pre-approved).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolSource {
    Canvas,
    Host,
    Builtin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Engine-specific billing unit, e.g. Copilot premium requests.
    pub premium_requests: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionDecision {
    AllowOnce,
    AllowForConversation,
    /// Approve this request and every later one in the conversation (the manager remembers
    /// it; engines still run in their sandbox). Adapters treat it like `AllowOnce`.
    AllowAll,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    /// "pending" | "in_progress" | "completed"
    pub status: String,
}

/// One selectable model as the engine lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    /// Engine process is up and authenticated; `model` if the engine reports it.
    Ready {
        engine: EngineKind,
        version: Option<String>,
        model: Option<String>,
        engine_session_id: Option<String>,
    },
    /// Models the engine offers for this session (sent once, when known).
    Models {
        available: Vec<ModelOption>,
    },
    /// The session's model changed (live switch via `agent_set_model`).
    ModelChanged {
        model: String,
    },
    TurnStarted {
        turn_id: String,
    },
    TextDelta {
        turn_id: String,
        text: String,
    },
    ThinkingDelta {
        turn_id: String,
        text: String,
    },
    ToolCall {
        turn_id: String,
        call_id: String,
        /// Fully-qualified tool name as the engine reports it.
        name: String,
        title: Option<String>,
        source: ToolSource,
        status: ToolCallStatus,
        input: Option<serde_json::Value>,
        /// Short text/summary of the result once completed or failed.
        output: Option<String>,
    },
    PermissionRequest {
        turn_id: String,
        request_id: String,
        tool_name: String,
        title: String,
        detail: Option<String>,
    },
    Plan {
        turn_id: String,
        entries: Vec<PlanEntry>,
    },
    /// The conversation's "allow all" approval mode changed (manager-emitted).
    ApprovalMode {
        allow_all: bool,
    },
    TurnEnded {
        turn_id: String,
        stop_reason: StopReason,
        usage: Option<Usage>,
    },
    Error {
        kind: ErrorKind,
        message: String,
        /// True when the session is dead and must be restarted.
        fatal: bool,
    },
    /// Engine process exited.
    Exited {
        code: Option<i32>,
    },
}

/// Payload of [`AGENT_EVENT`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub session_id: String,
    pub tab_id: String,
    pub event: AgentEvent,
}

/// Payload of [`AGENT_TOOL_CALL_EVENT`]: Rust (MCP server) asks the webview to run a canvas tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRequest {
    pub call_id: String,
    pub session_id: String,
    pub tab_id: String,
    /// Bare tool name from `tools.json` (e.g. `add_elements`).
    pub tool: String,
    pub args: serde_json::Value,
}

/// Webview → Rust via `agent_tool_result`. `content` follows MCP `CallToolResult.content`
/// (`[{type:"text",text}]` or `[{type:"image",data,mimeType}]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResult {
    pub call_id: String,
    pub is_error: bool,
    pub content: Vec<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_wire_shape_is_tagged_camel_case() {
        let e = AgentEvent::TurnEnded {
            turn_id: "t1".into(),
            stop_reason: StopReason::EndTurn,
            usage: None,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "turnEnded");
        assert_eq!(v["turnId"], "t1");
        assert_eq!(v["stopReason"], "endTurn");
    }
}
