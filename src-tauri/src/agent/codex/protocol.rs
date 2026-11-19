//! Codex app-server JSON-RPC wire types: the subset this adapter sends and reads.
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
//!
//! Shapes follow T3 Code's generated schema (`packages/effect-codex-app-server/src/_generated`),
//! which is generated from `codex app-server generate-json-schema`. Re-sync by diffing against
//! that output when bumping [`super::CODEX_MIN_VERSION`]. Unknown fields are ignored everywhere
//! so newer Codex releases stay compatible.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

// ---- outgoing request methods ----
pub const M_INITIALIZE: &str = "initialize";
pub const M_INITIALIZED: &str = "initialized";
pub const M_ACCOUNT_READ: &str = "account/read";
pub const M_CONFIG_READ: &str = "config/read";
pub const M_THREAD_START: &str = "thread/start";
pub const M_THREAD_RESUME: &str = "thread/resume";
pub const M_TURN_START: &str = "turn/start";
pub const M_TURN_INTERRUPT: &str = "turn/interrupt";

// ---- notifications ----
pub const N_TURN_STARTED: &str = "turn/started";
pub const N_TURN_COMPLETED: &str = "turn/completed";
pub const N_TURN_PLAN_UPDATED: &str = "turn/plan/updated";
pub const N_ITEM_STARTED: &str = "item/started";
pub const N_ITEM_COMPLETED: &str = "item/completed";
pub const N_AGENT_MESSAGE_DELTA: &str = "item/agentMessage/delta";
pub const N_REASONING_SUMMARY_DELTA: &str = "item/reasoning/summaryTextDelta";
pub const N_REASONING_SUMMARY_PART: &str = "item/reasoning/summaryPartAdded";
pub const N_REASONING_TEXT_DELTA: &str = "item/reasoning/textDelta";
pub const N_TOKEN_USAGE: &str = "thread/tokenUsage/updated";
pub const N_ERROR: &str = "error";
pub const N_SERVER_REQUEST_RESOLVED: &str = "serverRequest/resolved";

// ---- server -> client requests ----
pub const R_COMMAND_APPROVAL: &str = "item/commandExecution/requestApproval";
pub const R_FILE_CHANGE_APPROVAL: &str = "item/fileChange/requestApproval";
pub const R_PERMISSIONS_APPROVAL: &str = "item/permissions/requestApproval";
pub const R_MCP_ELICITATION: &str = "mcpServer/elicitation/request";
pub const R_USER_INPUT: &str = "item/tool/requestUserInput";
/// Legacy (v1) approval requests; still emitted by some Codex builds.
pub const R_EXEC_APPROVAL_V1: &str = "execCommandApproval";
pub const R_APPLY_PATCH_APPROVAL_V1: &str = "applyPatchApproval";

/// `_meta` keys Codex puts on MCP tool-approval elicitations (`codex_protocol::mcp_approval_meta`).
pub const META_APPROVAL_KIND: &str = "codex_approval_kind";
pub const META_APPROVAL_KIND_MCP_TOOL_CALL: &str = "mcp_tool_call";
pub const META_PERSIST: &str = "persist";
pub const META_PERSIST_SESSION: &str = "session";
pub const META_TOOL_NAME: &str = "tool_name";

/// JSON-RPC error code Codex uses for invalid requests (CODEX_HOME writer conflict, unknown thread).
pub const RPC_INVALID_REQUEST: i64 = -32600;
pub const RPC_METHOD_NOT_FOUND: i64 = -32601;

/// One parsed stdout frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response {
        id: Value,
        result: Result<Value, RpcError>,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize, Default)]
pub struct RpcError {
    #[serde(default)]
    pub code: i64,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Deserialize)]
struct RawFrame {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcError>,
}

/// Server requests and our responses share the `id` space syntactically (server ids start at 0),
/// so frames are routed on `method` first, never on `id` alone.
pub fn parse_frame(line: &str) -> Option<Incoming> {
    let raw: RawFrame = serde_json::from_str(line).ok()?;
    match (raw.id, raw.method) {
        (Some(id), Some(method)) if !id.is_null() => Some(Incoming::Request {
            id,
            method,
            params: raw.params,
        }),
        (_, Some(method)) => Some(Incoming::Notification {
            method,
            params: raw.params,
        }),
        (Some(id), None) => {
            let result = match raw.error {
                Some(err) => Err(err),
                None => Ok(raw.result.unwrap_or(Value::Null)),
            };
            Some(Incoming::Response { id, result })
        }
        (None, None) => None,
    }
}

pub fn request_line(id: u64, method: &str, params: impl Serialize) -> String {
    json!({ "id": id, "method": method, "params": params }).to_string()
}

pub fn notification_line(method: &str) -> String {
    json!({ "method": method }).to_string()
}

pub fn response_line(id: &Value, result: Value) -> String {
    json!({ "id": id, "result": result }).to_string()
}

pub fn error_response_line(id: &Value, code: i64, message: &str) -> String {
    json!({ "id": id, "error": { "code": code, "message": message } }).to_string()
}

// ---- outgoing params ----

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeCapabilities {
    pub experimental_api: bool,
    pub opt_out_notification_methods: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    pub capabilities: InitializeCapabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReadParams {
    pub cwd: String,
    pub include_layers: bool,
}

/// `thread/start` and (with `thread_id`) `thread/resume`.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThreadParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub approval_policy: &'static str,
    pub approvals_reviewer: &'static str,
    /// `SandboxMode`: always `read-only` (SEC-6).
    pub sandbox: &'static str,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    /// Dotted-path config overrides (`-c` semantics, merged recursively over the user's config).
    pub config: Map<String, Value>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SandboxPolicy {
    ReadOnly { network_access: bool },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserInput {
    Text { text: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    pub thread_id: String,
    pub input: Vec<UserInput>,
    pub approval_policy: &'static str,
    pub approvals_reviewer: &'static str,
    pub sandbox_policy: SandboxPolicy,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams {
    pub thread_id: String,
    pub turn_id: String,
}

// ---- incoming results ----

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InitializeResult {
    pub user_agent: Option<String>,
    pub codex_home: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountReadResult {
    pub account: Option<Value>,
    pub requires_openai_auth: bool,
}

#[derive(Debug, Deserialize)]
pub struct ThreadRef {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResult {
    pub thread: ThreadRef,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TurnError {
    pub message: String,
    pub codex_error_info: Option<Value>,
    pub additional_details: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRef {
    pub id: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub error: Option<TurnError>,
}

#[derive(Debug, Deserialize)]
pub struct TurnResult {
    pub turn: TurnRef,
}

// ---- incoming notification params ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnNotification {
    #[serde(default)]
    pub thread_id: Option<String>,
    pub turn: TurnRef,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemNotification {
    pub item: ThreadItem,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaNotification {
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub delta: String,
    #[serde(default)]
    pub summary_index: Option<u64>,
}

#[derive(Debug, Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenBreakdown {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct TokenUsage {
    pub last: Option<TokenBreakdown>,
    pub total: Option<TokenBreakdown>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageNotification {
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub token_usage: TokenUsage,
}

#[derive(Debug, Deserialize)]
pub struct PlanStep {
    pub step: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanNotification {
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub plan: Vec<PlanStep>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorNotification {
    pub error: TurnError,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub will_retry: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct McpToolCallResult {
    pub content: Vec<Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct McpToolCallError {
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUpdate {
    pub path: String,
}

/// `ThreadItem` variants this adapter renders; everything else is `Other`.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadItem {
    AgentMessage {
        id: String,
        #[serde(default)]
        text: String,
    },
    Reasoning {
        id: String,
        #[serde(default)]
        summary: Vec<String>,
    },
    CommandExecution {
        id: String,
        #[serde(default)]
        command: String,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        aggregated_output: Option<String>,
    },
    FileChange {
        id: String,
        #[serde(default)]
        changes: Vec<FileUpdate>,
        #[serde(default)]
        status: Option<String>,
    },
    McpToolCall {
        id: String,
        server: String,
        tool: String,
        #[serde(default)]
        arguments: Value,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        result: Option<McpToolCallResult>,
        #[serde(default)]
        error: Option<McpToolCallError>,
    },
    WebSearch {
        id: String,
        #[serde(default)]
        query: String,
    },
    #[serde(other)]
    Other,
}

// ---- server request params ----

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CommandApprovalParams {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub reason: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FileChangeApprovalParams {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub reason: Option<String>,
    pub grant_root: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionsApprovalParams {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub reason: Option<String>,
    pub permissions: Value,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct McpElicitationParams {
    pub server_name: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub message: String,
    pub mode: Option<String>,
    pub requested_schema: Option<Value>,
    #[serde(rename = "_meta")]
    pub meta: Option<Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExecApprovalV1Params {
    pub command: Vec<String>,
    pub cwd: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ApplyPatchApprovalV1Params {
    pub file_changes: Map<String, Value>,
    pub reason: Option<String>,
    pub grant_root: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_server_request_with_id_zero_as_request() {
        let f = parse_frame(
            r#"{"id":0,"method":"item/commandExecution/requestApproval","params":{"itemId":"x"}}"#,
        );
        assert!(
            matches!(f, Some(Incoming::Request { ref method, .. }) if method == R_COMMAND_APPROVAL)
        );
        let r = parse_frame(r#"{"id":0,"result":{}}"#);
        assert!(matches!(r, Some(Incoming::Response { result: Ok(_), .. })));
        let e = parse_frame(r#"{"id":3,"error":{"code":-32600,"message":"nope"}}"#);
        assert!(matches!(
            e,
            Some(Incoming::Response {
                result: Err(RpcError { code: -32600, .. }),
                ..
            })
        ));
        assert_eq!(parse_frame("not json"), None);
    }

    #[test]
    fn unknown_item_types_parse_as_other() {
        let item: ThreadItem =
            serde_json::from_str(r#"{"type":"collabAgentToolCall","id":"x","tool":"spawnAgent"}"#)
                .unwrap();
        assert!(matches!(item, ThreadItem::Other));
    }

    #[test]
    fn sandbox_policy_wire_shape() {
        let v = serde_json::to_value(SandboxPolicy::ReadOnly {
            network_access: false,
        })
        .unwrap();
        assert_eq!(v, json!({"type": "readOnly", "networkAccess": false}));
    }
}
