//! Agent Client Protocol (ACP v1) wire types: the subset the desktop client sends and receives.
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
//! Ported from `packages/effect-acp/src/_generated/schema-v1.gen.ts`. Loose or unstable fields stay
//! `serde_json::Value` so newer agents never fail to decode.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 1;

pub mod method {
    pub const INITIALIZE: &str = "initialize";
    pub const SESSION_NEW: &str = "session/new";
    pub const SESSION_LOAD: &str = "session/load";
    pub const SESSION_PROMPT: &str = "session/prompt";
    pub const SESSION_CANCEL: &str = "session/cancel";
    pub const SESSION_SET_MODEL: &str = "session/set_model";
    pub const SESSION_SET_CONFIG_OPTION: &str = "session/set_config_option";
    pub const SESSION_UPDATE: &str = "session/update";
    pub const SESSION_REQUEST_PERMISSION: &str = "session/request_permission";
}

/// JSON-RPC 2.0 error codes used by ACP.
pub mod error_code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    pub const REQUEST_CANCELLED: i64 = -32800;
    pub const AUTH_REQUIRED: i64 = -32000;
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    /// Message plus any `data.details` / string `data`, for marker matching and display.
    pub fn full_text(&self) -> String {
        let detail = match &self.data {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Object(o)) => o
                .get("details")
                .or_else(|| o.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            _ => None,
        };
        match detail {
            Some(d) if !d.is_empty() && d != self.message => format!("{}: {d}", self.message),
            _ => self.message.clone(),
        }
    }
}

/// One decoded inbound line.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: Value,
        result: Result<Value, RpcError>,
    },
}

impl Incoming {
    pub fn parse(line: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        let obj = v.as_object().ok_or("JSON-RPC message is not an object")?;
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        match (obj.get("method").and_then(Value::as_str), obj.get("id")) {
            (Some(m), Some(id)) if !id.is_null() => Ok(Incoming::Request {
                id: id.clone(),
                method: m.to_owned(),
                params,
            }),
            (Some(m), _) => Ok(Incoming::Notification {
                method: m.to_owned(),
                params,
            }),
            (None, Some(id)) => {
                let result = match obj.get("error") {
                    Some(e) if !e.is_null() => Err(serde_json::from_value(e.clone())
                        .map_err(|err| format!("bad JSON-RPC error: {err}"))?),
                    _ => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
                };
                Ok(Incoming::Response {
                    id: id.clone(),
                    result,
                })
            }
            (None, None) => Err("JSON-RPC message has neither method nor id".into()),
        }
    }
}

pub fn request_line(id: u64, method: &str, params: impl Serialize) -> String {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
}

pub fn notification_line(method: &str, params: impl Serialize) -> String {
    serde_json::json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string()
}

pub fn result_line(id: &Value, result: impl Serialize) -> String {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()
}

pub fn error_line(id: &Value, code: i64, message: &str) -> String {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
        .to_string()
}

// ---------------------------------------------------------------------------------------------
// Client → agent
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeRequest {
    pub protocol_version: u64,
    pub client_capabilities: ClientCapabilities,
    pub client_info: Implementation,
}

/// We advertise no `fs` / `terminal` capabilities: the agent must not reach the host through us.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    pub fs: FileSystemCapability,
    pub terminal: bool,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemCapability {
    pub read_text_file: bool,
    pub write_text_file: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Implementation {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionRequest {
    pub cwd: String,
    pub mcp_servers: Vec<McpServer>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSessionRequest {
    pub session_id: String,
    pub cwd: String,
    pub mcp_servers: Vec<McpServer>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub session_id: String,
    pub prompt: Vec<ContentBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelNotification {
    pub session_id: String,
}

/// Unstable `session/set_model`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModelRequest {
    pub session_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigOptionRequest {
    pub session_id: String,
    pub config_id: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NameValue {
    pub name: String,
    pub value: String,
}

/// `McpServer`: stdio has no `type` tag; http/sse carry `"type"`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum McpServer {
    Http {
        #[serde(rename = "type")]
        kind: &'static str,
        name: String,
        url: String,
        headers: Vec<NameValue>,
    },
    Stdio {
        name: String,
        command: String,
        args: Vec<String>,
        env: Vec<NameValue>,
    },
}

impl McpServer {
    pub fn http(name: &str, url: &str, headers: Vec<NameValue>) -> Self {
        McpServer::Http {
            kind: "http",
            name: name.into(),
            url: url.into(),
            headers,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPermissionResponse {
    pub outcome: PermissionOutcome,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PermissionOutcome {
    Cancelled,
    Selected {
        #[serde(rename = "optionId")]
        option_id: String,
    },
}

// ---------------------------------------------------------------------------------------------
// Agent → client
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    #[serde(default)]
    pub protocol_version: Option<u64>,
    #[serde(default)]
    pub agent_capabilities: AgentCapabilities,
    #[serde(default)]
    pub auth_methods: Vec<Value>,
    #[serde(default)]
    pub agent_info: Option<Implementation>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    #[serde(default)]
    pub load_session: bool,
    #[serde(default)]
    pub mcp_capabilities: McpCapabilities,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct McpCapabilities {
    #[serde(default)]
    pub http: bool,
    #[serde(default)]
    pub sse: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionResponse {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub models: Option<SessionModelState>,
    #[serde(default)]
    pub config_options: Vec<SessionConfigOption>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelState {
    #[serde(default)]
    pub current_model_id: Option<String>,
    #[serde(default)]
    pub available_models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub model_id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigOption {
    pub id: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub current_value: Value,
    #[serde(default)]
    pub options: Value,
}

impl SessionConfigOption {
    pub fn is_model_select(&self) -> bool {
        self.category.as_deref() == Some("model")
            && self.kind.as_deref() == Some("select")
            && !self.id.trim().is_empty()
    }

    /// Values of a select option (flat list or grouped `{group, options}`).
    pub fn select_values(&self) -> Vec<String> {
        fn collect(v: &Value, out: &mut Vec<String>) {
            if let Some(arr) = v.as_array() {
                for item in arr {
                    if let Some(val) = item.get("value").and_then(Value::as_str) {
                        out.push(val.to_owned());
                    } else if let Some(group) = item.get("options") {
                        collect(group, out);
                    }
                }
            }
        }
        let mut out = Vec::new();
        collect(&self.options, &mut out);
        out
    }
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub usage: Option<PromptUsage>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptUsage {
    #[serde(default)]
    pub total_tokens: Option<u64>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub thought_tokens: Option<u64>,
    #[serde(default)]
    pub cached_read_tokens: Option<u64>,
    #[serde(default)]
    pub cached_write_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotification {
    pub session_id: String,
    pub update: SessionUpdate,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum SessionUpdate {
    UserMessageChunk {
        #[serde(default)]
        content: Value,
    },
    AgentMessageChunk {
        #[serde(default)]
        content: Value,
    },
    AgentThoughtChunk {
        #[serde(default)]
        content: Value,
    },
    ToolCall(ToolCallFields),
    ToolCallUpdate(ToolCallFields),
    Plan {
        #[serde(default)]
        entries: Vec<AcpPlanEntry>,
    },
    CurrentModeUpdate {
        #[serde(default, rename = "currentModeId")]
        current_mode_id: Option<String>,
    },
    UsageUpdate {
        #[serde(default)]
        used: Option<u64>,
        #[serde(default)]
        size: Option<u64>,
        #[serde(default)]
        cost: Option<Value>,
    },
    /// `available_commands_update`, `config_option_update`, `session_info_update`, and
    /// anything newer.
    #[serde(other)]
    Other,
}

/// Shared shape of `tool_call` (title required by spec) and `tool_call_update` (all optional).
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallFields {
    pub tool_call_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub content: Option<Vec<Value>>,
    #[serde(default)]
    pub raw_input: Option<Value>,
    #[serde(default)]
    pub raw_output: Option<Value>,
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AcpPlanEntry {
    pub content: String,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPermissionRequest {
    pub session_id: String,
    pub tool_call: ToolCallFields,
    #[serde(default)]
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    #[serde(default)]
    pub name: String,
    /// `allow_once` | `allow_always` | `reject_once` | `reject_always`
    pub kind: String,
}

/// Plain text of a `ContentBlock` (text or resource text); other block types yield `None`.
pub fn content_text(block: &Value) -> Option<&str> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => block.get("text").and_then(Value::as_str),
        Some("resource") => block
            .get("resource")
            .and_then(|r| r.get("text"))
            .and_then(Value::as_str),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_requests_notifications_and_responses() {
        let req = Incoming::parse(
            r#"{"jsonrpc":"2.0","id":"a","method":"session/request_permission","params":{}}"#,
        )
        .unwrap();
        assert!(
            matches!(req, Incoming::Request { ref method, .. } if method == "session/request_permission")
        );
        let n =
            Incoming::parse(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#).unwrap();
        assert!(matches!(n, Incoming::Notification { .. }));
        let ok = Incoming::parse(r#"{"jsonrpc":"2.0","id":1,"result":{"x":1}}"#).unwrap();
        assert_eq!(
            ok,
            Incoming::Response {
                id: json!(1),
                result: Ok(json!({"x":1}))
            }
        );
        let err = Incoming::parse(
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Internal error","data":{"details":"boom"}}}"#,
        )
        .unwrap();
        match err {
            Incoming::Response { result: Err(e), .. } => {
                assert_eq!(e.code, error_code::INTERNAL_ERROR);
                assert_eq!(e.full_text(), "Internal error: boom");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(Incoming::parse("not json").is_err());
        assert!(Incoming::parse(r#"{"jsonrpc":"2.0"}"#).is_err());
    }

    #[test]
    fn mcp_servers_serialize_to_acp_shapes() {
        let http = McpServer::http(
            "excalidraw",
            "http://127.0.0.1:1/mcp",
            vec![NameValue {
                name: "Authorization".into(),
                value: "Bearer t".into(),
            }],
        );
        assert_eq!(
            serde_json::to_value(&http).unwrap(),
            json!({"type":"http","name":"excalidraw","url":"http://127.0.0.1:1/mcp",
                   "headers":[{"name":"Authorization","value":"Bearer t"}]})
        );
        let stdio = McpServer::Stdio {
            name: "excalidraw".into(),
            command: "/app".into(),
            args: vec!["--mcp-shim".into()],
            env: vec![],
        };
        let v = serde_json::to_value(&stdio).unwrap();
        assert!(v.get("type").is_none(), "stdio servers carry no type tag");
        assert_eq!(v["command"], "/app");
    }

    #[test]
    fn session_updates_decode_and_tolerate_unknown_variants() {
        let n: SessionNotification = serde_json::from_value(json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"}
        }))
        .unwrap();
        assert!(
            matches!(n.update, SessionUpdate::ToolCallUpdate(ref f) if f.status.as_deref() == Some("completed"))
        );
        let n: SessionNotification = serde_json::from_value(json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "brand_new_thing", "foo": 1}
        }))
        .unwrap();
        assert_eq!(n.update, SessionUpdate::Other);
    }

    #[test]
    fn permission_outcome_wire_shape() {
        let sel = RequestPermissionResponse {
            outcome: PermissionOutcome::Selected {
                option_id: "allow".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(sel).unwrap(),
            json!({"outcome":{"outcome":"selected","optionId":"allow"}})
        );
        let c = RequestPermissionResponse {
            outcome: PermissionOutcome::Cancelled,
        };
        assert_eq!(
            serde_json::to_value(c).unwrap(),
            json!({"outcome":{"outcome":"cancelled"}})
        );
    }

    #[test]
    fn grouped_select_values_flatten() {
        let o: SessionConfigOption = serde_json::from_value(json!({
            "id": "model", "category": "model", "type": "select", "currentValue": "a",
            "options": [{"value": "a", "name": "A"}, {"group": "g", "name": "G", "options": [{"value": "b", "name": "B"}]}]
        }))
        .unwrap();
        assert!(o.is_model_select());
        assert_eq!(o.select_values(), vec!["a", "b"]);
    }
}
