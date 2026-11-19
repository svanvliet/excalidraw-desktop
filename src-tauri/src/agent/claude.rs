//! Claude Code adapter: drives `claude -p` in bidirectional stream-json mode with the same
//! stdio control protocol the Claude Agent SDK uses (`initialize`, `can_use_tool`,
//! `interrupt`). Permissions flow over stdio (`--permission-prompt-tool stdio`), so no MCP
//! approval tool is needed. Canvas MCP tools are reached through the `--mcp-shim` stdio
//! server, which inherits the bearer token from the environment (never from argv).
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
use super::adapter::{
    AdapterOutput, EngineAdapter, LaunchSpec, SessionConfig, MCP_SERVER_NAME, MCP_TOKEN_ENV,
    MCP_URL_ENV,
};
use super::events::{
    AgentEvent, EngineKind, ErrorKind, PermissionDecision, StopReason, ToolCallStatus, ToolSource,
    Usage,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// Built-in tools that can run commands or modify files. Always disallowed (SEC-6), even
/// though `--tools` already omits them, so a future CLI that ignores `--tools` stays sandboxed.
pub const DISALLOWED_TOOLS: &[&str] = &[
    "Bash",
    "BashOutput",
    "KillShell",
    "KillBash",
    "PowerShell",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
];

/// Built-in tool allowlist (`--tools`). MCP tools are unaffected by it. `ToolSearch` is
/// required: Claude defers MCP tool schemas and loads them via `ToolSearch select:`.
pub const BUILTIN_TOOLS: &[&str] = &[
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "ToolSearch",
];

/// Credentials that would silently switch billing away from the user's Claude login (SEC-6),
/// plus the nested-session marker set when the app itself is launched from Claude Code.
/// Deliberate provider choices (Bedrock/Vertex/Foundry, `CLAUDE_CODE_OAUTH_TOKEN`,
/// `ANTHROPIC_BASE_URL`) are kept so enterprise setups keep working.
pub const ENV_REMOVE: &[&str] = &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"];

/// Engine-internal tools not shown as tool calls.
const HIDDEN_TOOLS: &[&str] = &["ToolSearch"];
const OUTPUT_PREVIEW_CHARS: usize = 500;
const DETAIL_PREVIEW_CHARS: usize = 300;

fn canvas_prefix() -> String {
    format!("mcp__{MCP_SERVER_NAME}__")
}

pub fn tool_source(name: &str) -> ToolSource {
    if name.starts_with(&canvas_prefix()) {
        ToolSource::Canvas
    } else if name.starts_with("mcp__") {
        ToolSource::Host
    } else {
        ToolSource::Builtin
    }
}

/// `--mcp-config` JSON. Uses the stdio shim so the token stays in the environment; falls back
/// to streamable HTTP with an `Authorization` header only when no shim is available.
pub fn mcp_config_json(cfg: &SessionConfig) -> String {
    let server = match cfg.mcp.shim_command.split_first() {
        Some((command, args)) => json!({ "type": "stdio", "command": command, "args": args }),
        None => json!({
            "type": "http",
            "url": cfg.mcp.url,
            "headers": { "Authorization": format!("Bearer {}", cfg.mcp.token) },
        }),
    };
    json!({ "mcpServers": { MCP_SERVER_NAME: server } }).to_string()
}

fn build_args(cfg: &SessionConfig, new_session_id: &str) -> Vec<String> {
    let mut tools: Vec<&str> = BUILTIN_TOOLS.to_vec();
    if cfg.use_host_config {
        tools.push("Skill");
    }
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        // Overrides a user's `defaultMode: bypassPermissions` so approvals always reach us.
        "--permission-mode",
        "default",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push("--tools".into());
    args.push(tools.join(","));
    args.push("--disallowedTools".into());
    args.push(DISALLOWED_TOOLS.join(","));
    args.push("--allowedTools".into());
    args.push(format!("mcp__{MCP_SERVER_NAME}"));
    args.push("--mcp-config".into());
    args.push(mcp_config_json(cfg));
    if cfg.use_host_config {
        // User-level MCPs/skills/plugins only: project settings in the attached folder could
        // carry hooks or MCP servers the user never reviewed.
        args.push("--setting-sources".into());
        args.push("user".into());
    } else {
        args.push("--strict-mcp-config".into());
        args.push("--setting-sources".into());
        args.push(String::new());
    }
    if !cfg.system_prompt.is_empty() {
        args.push("--append-system-prompt".into());
        args.push(cfg.system_prompt.clone());
    }
    if let Some(model) = cfg.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.to_string());
    }
    match cfg.resume_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => {
            args.push("--resume".into());
            args.push(id.to_string());
        }
        None => {
            args.push("--session-id".into());
            args.push(new_session_id.to_string());
        }
    }
    if let Some(folder) = &cfg.attached_folder {
        if folder != &cfg.cwd {
            args.push("--add-dir".into());
            args.push(folder.to_string_lossy().into_owned());
        }
    }
    args
}

fn new_uuid_v4() -> String {
    let mut b = rand::random::<u128>().to_be_bytes();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn truncate(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => format!("{}…", &s[..idx]),
        None => s.to_string(),
    }
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// Text of a `tool_result.content` (string or content-block array).
fn tool_result_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|b| str_field(b, "type") == Some("text"))
                .filter_map(|b| str_field(b, "text"))
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

fn assistant_error_kind(code: &str) -> ErrorKind {
    match code {
        "authentication_failed" => ErrorKind::NotLoggedIn,
        "oauth_org_not_allowed" => ErrorKind::OrgDisabled,
        "rate_limit" | "billing_error" => ErrorKind::QuotaExceeded,
        _ => ErrorKind::Other,
    }
}

fn control_success(request_id: &str, response: Value) -> String {
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response },
    })
    .to_string()
}

fn control_error(request_id: &str, error: &str) -> String {
    json!({
        "type": "control_response",
        "response": { "subtype": "error", "request_id": request_id, "error": error },
    })
    .to_string()
}

fn allow_line(request_id: &str, input: &Value) -> String {
    control_success(
        request_id,
        json!({ "behavior": "allow", "updatedInput": input }),
    )
}

fn deny_line(request_id: &str) -> String {
    control_success(
        request_id,
        json!({ "behavior": "deny", "message": "The user denied this tool call." }),
    )
}

struct PendingPermission {
    tool_name: String,
    input: Value,
}

/// Sans-IO adapter for `claude -p --input-format stream-json --output-format stream-json`.
pub struct ClaudeAdapter {
    /// Used as `--session-id` when not resuming, so `Ready` can report it before the first turn.
    new_session_id: String,
    session_id: Option<String>,
    requested_model: Option<String>,
    model: Option<String>,
    next_request: u64,
    init_request_id: Option<String>,
    ready_sent: bool,
    auth_failed: bool,
    turn: Option<String>,
    cancel_requested: bool,
    turn_error_reported: bool,
    pending: HashMap<String, PendingPermission>,
    allowed_for_conversation: HashSet<String>,
    hidden_calls: HashSet<String>,
    tool_names: HashMap<String, String>,
    streaming_message: Option<String>,
    streamed_messages: HashSet<String>,
}

impl Default for ClaudeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeAdapter {
    pub fn new() -> Self {
        Self {
            new_session_id: new_uuid_v4(),
            session_id: None,
            requested_model: None,
            model: None,
            next_request: 0,
            init_request_id: None,
            ready_sent: false,
            auth_failed: false,
            turn: None,
            cancel_requested: false,
            turn_error_reported: false,
            pending: HashMap::new(),
            allowed_for_conversation: HashSet::new(),
            hidden_calls: HashSet::new(),
            tool_names: HashMap::new(),
            streaming_message: None,
            streamed_messages: HashSet::new(),
        }
    }

    fn next_request_id(&mut self, prefix: &str) -> String {
        self.next_request += 1;
        format!("{prefix}-{}", self.next_request)
    }

    fn ready_event(&self, version: Option<String>) -> AgentEvent {
        AgentEvent::Ready {
            engine: EngineKind::Claude,
            version,
            model: self.model.clone(),
            engine_session_id: self.session_id.clone(),
        }
    }

    fn turn_error(&mut self, out: &mut AdapterOutput, kind: ErrorKind, message: String) {
        if self.turn_error_reported || self.auth_failed {
            return;
        }
        self.turn_error_reported = true;
        let fatal = matches!(kind, ErrorKind::NotLoggedIn | ErrorKind::OrgDisabled);
        if fatal {
            self.auth_failed = true;
        }
        out.events.push(AgentEvent::Error {
            kind,
            message,
            fatal,
        });
    }

    fn on_control_response(&mut self, msg: &Value, out: &mut AdapterOutput) {
        let Some(resp) = msg.get("response") else {
            return;
        };
        if str_field(resp, "request_id") != self.init_request_id.as_deref() {
            return;
        }
        if str_field(resp, "subtype") != Some("success") {
            let detail = str_field(resp, "error").unwrap_or("unknown error");
            out.events.push(AgentEvent::Error {
                kind: ErrorKind::Protocol,
                message: format!("Claude Code initialize failed: {detail}"),
                fatal: true,
            });
            return;
        }
        let info = resp.get("response").cloned().unwrap_or(Value::Null);
        let account = info.get("account").cloned().unwrap_or(Value::Null);
        let first_party = matches!(
            str_field(&account, "apiProvider"),
            None | Some("firstParty")
        );
        if first_party && str_field(&account, "tokenSource") == Some("none") {
            self.auth_failed = true;
            out.events.push(AgentEvent::Error {
                kind: ErrorKind::NotLoggedIn,
                message: "Claude Code is not logged in. Run `claude` in a terminal and use /login."
                    .into(),
                fatal: true,
            });
            return;
        }
        let target = self.requested_model.as_deref().unwrap_or("default");
        let resolved = info
            .get("models")
            .and_then(Value::as_array)
            .and_then(|models| {
                models
                    .iter()
                    .find(|m| str_field(m, "value") == Some(target))
                    .and_then(|m| str_field(m, "resolvedModel"))
            });
        self.model = resolved
            .map(str::to_string)
            .or_else(|| self.requested_model.clone());
        let version = str_field(&info, "claude_code_version").map(str::to_string);
        self.ready_sent = true;
        out.events.push(self.ready_event(version));
    }

    fn on_system(&mut self, msg: &Value, out: &mut AdapterOutput) {
        if str_field(msg, "subtype") != Some("init") || self.auth_failed {
            return;
        }
        let session_id = str_field(msg, "session_id").map(str::to_string);
        if let Some(model) = str_field(msg, "model") {
            self.model = Some(model.to_string());
        }
        let session_changed = session_id.is_some() && session_id != self.session_id;
        if session_changed {
            if self.ready_sent {
                log::warn!("claude: engine session id changed after start");
            }
            self.session_id = session_id;
        }
        if !self.ready_sent || session_changed {
            self.ready_sent = true;
            let version = str_field(msg, "claude_code_version").map(str::to_string);
            out.events.push(self.ready_event(version));
        }
    }

    fn on_stream_event(&mut self, msg: &Value, out: &mut AdapterOutput) {
        if !msg.get("parent_tool_use_id").is_none_or(Value::is_null) {
            return;
        }
        let Some(event) = msg.get("event") else {
            return;
        };
        match str_field(event, "type") {
            Some("message_start") => {
                self.streaming_message = event
                    .get("message")
                    .and_then(|m| str_field(m, "id"))
                    .map(str::to_string);
            }
            Some("content_block_delta") => {
                let Some(turn_id) = self.turn.clone() else {
                    return;
                };
                let Some(delta) = event.get("delta") else {
                    return;
                };
                let ev = match str_field(delta, "type") {
                    Some("text_delta") => str_field(delta, "text").map(|t| AgentEvent::TextDelta {
                        turn_id,
                        text: t.to_string(),
                    }),
                    Some("thinking_delta") => {
                        str_field(delta, "thinking").map(|t| AgentEvent::ThinkingDelta {
                            turn_id,
                            text: t.to_string(),
                        })
                    }
                    _ => None,
                };
                if let Some(ev) = ev {
                    if let Some(id) = &self.streaming_message {
                        self.streamed_messages.insert(id.clone());
                    }
                    out.events.push(ev);
                }
            }
            _ => {}
        }
    }

    fn on_assistant(&mut self, msg: &Value, out: &mut AdapterOutput) {
        if !msg.get("parent_tool_use_id").is_none_or(Value::is_null) {
            return;
        }
        let Some(turn_id) = self.turn.clone() else {
            return;
        };
        let Some(message) = msg.get("message") else {
            return;
        };
        let blocks = message
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(code) = str_field(msg, "error") {
            let text = tool_result_text(&Value::Array(blocks)).unwrap_or_else(|| code.to_string());
            self.turn_error(out, assistant_error_kind(code), text);
            return;
        }
        let streamed =
            str_field(message, "id").is_some_and(|id| self.streamed_messages.contains(id));
        for block in &blocks {
            match str_field(block, "type") {
                Some("text") if !streamed => {
                    if let Some(text) = str_field(block, "text").filter(|t| !t.is_empty()) {
                        out.events.push(AgentEvent::TextDelta {
                            turn_id: turn_id.clone(),
                            text: text.to_string(),
                        });
                    }
                }
                Some("thinking") if !streamed => {
                    if let Some(text) = str_field(block, "thinking").filter(|t| !t.is_empty()) {
                        out.events.push(AgentEvent::ThinkingDelta {
                            turn_id: turn_id.clone(),
                            text: text.to_string(),
                        });
                    }
                }
                Some("tool_use") => {
                    let (Some(id), Some(name)) = (str_field(block, "id"), str_field(block, "name"))
                    else {
                        continue;
                    };
                    if HIDDEN_TOOLS.contains(&name) {
                        self.hidden_calls.insert(id.to_string());
                        continue;
                    }
                    self.tool_names.insert(id.to_string(), name.to_string());
                    out.events.push(AgentEvent::ToolCall {
                        turn_id: turn_id.clone(),
                        call_id: id.to_string(),
                        name: name.to_string(),
                        title: None,
                        source: tool_source(name),
                        status: ToolCallStatus::Running,
                        input: block.get("input").cloned(),
                        output: None,
                    });
                }
                _ => {}
            }
        }
    }

    fn on_user(&mut self, msg: &Value, out: &mut AdapterOutput) {
        if !msg.get("parent_tool_use_id").is_none_or(Value::is_null) {
            return;
        }
        let Some(turn_id) = self.turn.clone() else {
            return;
        };
        let Some(blocks) = msg
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            return;
        };
        for block in blocks {
            if str_field(block, "type") != Some("tool_result") {
                continue;
            }
            let Some(id) = str_field(block, "tool_use_id") else {
                continue;
            };
            if self.hidden_calls.remove(id) {
                continue;
            }
            let Some(name) = self.tool_names.remove(id) else {
                continue;
            };
            let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
            out.events.push(AgentEvent::ToolCall {
                turn_id: turn_id.clone(),
                call_id: id.to_string(),
                source: tool_source(&name),
                name,
                title: None,
                status: if failed {
                    ToolCallStatus::Failed
                } else {
                    ToolCallStatus::Completed
                },
                input: None,
                output: block
                    .get("content")
                    .and_then(tool_result_text)
                    .map(|t| truncate(&t, OUTPUT_PREVIEW_CHARS)),
            });
        }
    }

    fn on_control_request(&mut self, msg: &Value, out: &mut AdapterOutput) {
        let Some(request_id) = str_field(msg, "request_id") else {
            return;
        };
        let request = msg.get("request").cloned().unwrap_or(Value::Null);
        let subtype = str_field(&request, "subtype").unwrap_or_default();
        if subtype != "can_use_tool" {
            out.writes.push(control_error(
                request_id,
                &format!("unsupported control request: {subtype}"),
            ));
            return;
        }
        let tool_name = str_field(&request, "tool_name")
            .unwrap_or_default()
            .to_string();
        let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
        if tool_source(&tool_name) == ToolSource::Canvas
            || self.allowed_for_conversation.contains(&tool_name)
        {
            out.writes.push(allow_line(request_id, &input));
            return;
        }
        let title = str_field(&request, "display_name")
            .or_else(|| str_field(&request, "title"))
            .unwrap_or(&tool_name)
            .to_string();
        let detail = str_field(&request, "description")
            .map(str::to_string)
            .or_else(|| Some(truncate(&input.to_string(), DETAIL_PREVIEW_CHARS)));
        out.events.push(AgentEvent::PermissionRequest {
            turn_id: self.turn.clone().unwrap_or_default(),
            request_id: request_id.to_string(),
            tool_name: tool_name.clone(),
            title,
            detail,
        });
        self.pending.insert(
            request_id.to_string(),
            PendingPermission { tool_name, input },
        );
    }

    fn on_rate_limit(&mut self, msg: &Value, out: &mut AdapterOutput) {
        let Some(info) = msg.get("rate_limit_info") else {
            return;
        };
        let using_overage = info.get("isUsingOverage").and_then(Value::as_bool) == Some(true);
        if str_field(info, "status") != Some("rejected") || using_overage {
            return;
        }
        let window = str_field(info, "rateLimitType").unwrap_or("usage");
        let mut message = format!("Claude {window} limit reached");
        if let Some(resets_at) = info.get("resetsAt").and_then(Value::as_i64) {
            message.push_str(&format!(" (resets at unix time {resets_at})"));
        }
        message.push('.');
        self.turn_error(out, ErrorKind::QuotaExceeded, message);
    }

    fn on_result(&mut self, msg: &Value, out: &mut AdapterOutput) {
        let Some(turn_id) = self.turn.take() else {
            return;
        };
        let subtype = str_field(msg, "subtype").unwrap_or_default();
        let is_error = msg.get("is_error").and_then(Value::as_bool) == Some(true);
        let aborted = str_field(msg, "terminal_reason").is_some_and(|r| r.starts_with("aborted"));
        let stop_reason = if self.cancel_requested || aborted {
            StopReason::Cancelled
        } else {
            match subtype {
                "success" if !is_error => {
                    if str_field(msg, "stop_reason") == Some("refusal") {
                        StopReason::Refusal
                    } else {
                        StopReason::EndTurn
                    }
                }
                "error_max_turns" => StopReason::MaxTurns,
                _ => StopReason::Error,
            }
        };
        if stop_reason == StopReason::Error {
            let kind = match msg.get("api_error_status").and_then(Value::as_u64) {
                Some(401) => ErrorKind::NotLoggedIn,
                Some(429) => ErrorKind::QuotaExceeded,
                _ => ErrorKind::Other,
            };
            let message = str_field(msg, "result")
                .map(str::to_string)
                .or_else(|| {
                    msg.get("errors").and_then(Value::as_array).map(|errs| {
                        errs.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("; ")
                    })
                })
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| format!("Claude Code turn failed ({subtype})"));
            self.turn_error(out, kind, message);
        }
        let usage = msg.get("usage").map(|u| {
            let n = |k: &str| u.get(k).and_then(Value::as_u64);
            let input = [
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            ]
            .iter()
            .filter_map(|k| n(k))
            .reduce(|a, b| a + b);
            Usage {
                input_tokens: input,
                output_tokens: n("output_tokens"),
                premium_requests: None,
            }
        });
        out.events.push(AgentEvent::TurnEnded {
            turn_id,
            stop_reason,
            usage,
        });
        self.reset_turn_state();
    }

    fn reset_turn_state(&mut self) {
        self.cancel_requested = false;
        self.turn_error_reported = false;
        self.pending.clear();
        self.hidden_calls.clear();
        self.tool_names.clear();
        self.streaming_message = None;
        self.streamed_messages.clear();
    }
}

impl EngineAdapter for ClaudeAdapter {
    fn kind(&self) -> EngineKind {
        EngineKind::Claude
    }

    fn launch_spec(&self, cfg: &SessionConfig) -> LaunchSpec {
        LaunchSpec {
            program: cfg.binary.clone(),
            args: build_args(cfg, &self.new_session_id),
            env_set: vec![
                (MCP_URL_ENV.to_string(), cfg.mcp.url.clone()),
                (MCP_TOKEN_ENV.to_string(), cfg.mcp.token.clone()),
            ],
            env_remove: ENV_REMOVE.iter().map(|s| s.to_string()).collect(),
            cwd: cfg.cwd.clone(),
        }
    }

    fn start(&mut self, cfg: &SessionConfig) -> AdapterOutput {
        self.requested_model = cfg.model.clone().filter(|m| !m.is_empty());
        self.model = self.requested_model.clone();
        self.session_id = Some(
            cfg.resume_id
                .clone()
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| self.new_session_id.clone()),
        );
        let id = self.next_request_id("init");
        self.init_request_id = Some(id.clone());
        AdapterOutput {
            events: vec![],
            writes: vec![json!({
                "type": "control_request",
                "request_id": id,
                "request": { "subtype": "initialize", "hooks": {} },
            })
            .to_string()],
        }
    }

    fn prompt(&mut self, turn_id: &str, text: &str) -> AdapterOutput {
        self.reset_turn_state();
        self.turn = Some(turn_id.to_string());
        AdapterOutput {
            events: vec![AgentEvent::TurnStarted {
                turn_id: turn_id.to_string(),
            }],
            writes: vec![json!({
                "type": "user",
                "message": { "role": "user", "content": text },
                "parent_tool_use_id": null,
                "session_id": "",
            })
            .to_string()],
        }
    }

    fn cancel(&mut self) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        if self.turn.is_none() || self.cancel_requested {
            return out;
        }
        self.cancel_requested = true;
        let mut pending: Vec<String> = self.pending.drain().map(|(id, _)| id).collect();
        pending.sort();
        out.writes.extend(pending.iter().map(|id| deny_line(id)));
        let id = self.next_request_id("interrupt");
        out.writes.push(
            json!({
                "type": "control_request",
                "request_id": id,
                "request": { "subtype": "interrupt" },
            })
            .to_string(),
        );
        out
    }

    fn respond_permission(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        let Some(p) = self.pending.remove(request_id) else {
            log::warn!("claude: no pending permission {request_id}");
            return out;
        };
        out.writes.push(match decision {
            PermissionDecision::Deny => deny_line(request_id),
            PermissionDecision::AllowOnce => allow_line(request_id, &p.input),
            PermissionDecision::AllowForConversation => {
                self.allowed_for_conversation.insert(p.tool_name);
                allow_line(request_id, &p.input)
            }
        });
        out
    }

    fn on_line(&mut self, line: &str) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        let line = line.trim();
        if line.is_empty() {
            return out;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("claude: non-JSON stdout line ignored: {e}");
                return out;
            }
        };
        match str_field(&msg, "type").unwrap_or_default() {
            "control_response" => self.on_control_response(&msg, &mut out),
            "control_request" => self.on_control_request(&msg, &mut out),
            "control_cancel_request" => {
                if let Some(id) = str_field(&msg, "request_id") {
                    self.pending.remove(id);
                }
            }
            "system" => self.on_system(&msg, &mut out),
            "stream_event" => self.on_stream_event(&msg, &mut out),
            "assistant" => self.on_assistant(&msg, &mut out),
            "user" => self.on_user(&msg, &mut out),
            "rate_limit_event" => self.on_rate_limit(&msg, &mut out),
            "result" => self.on_result(&msg, &mut out),
            _ => {}
        }
        out
    }

    fn on_stderr(&mut self, line: &str) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        let lower = line.to_ascii_lowercase();
        let auth = [
            "please run /login",
            "not logged in",
            "invalid api key",
            "oauth token has expired",
        ]
        .iter()
        .any(|p| lower.contains(p));
        if auth && !self.auth_failed {
            self.auth_failed = true;
            self.turn_error_reported = true;
            out.events.push(AgentEvent::Error {
                kind: ErrorKind::NotLoggedIn,
                message: line.trim().to_string(),
                fatal: true,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::adapter::McpEndpoint;
    use std::path::PathBuf;

    const HI: &str = include_str!("../../tests/fixtures/claude/hi.ndjson");
    const CANVAS: &str = include_str!("../../tests/fixtures/claude/canvas.ndjson");
    const DENY: &str = include_str!("../../tests/fixtures/claude/deny.ndjson");
    const INTERRUPT: &str = include_str!("../../tests/fixtures/claude/interrupt.ndjson");
    const NOT_LOGGED_IN: &str = include_str!("../../tests/fixtures/claude/not_logged_in.ndjson");

    fn cfg(use_host_config: bool) -> SessionConfig {
        SessionConfig {
            engine: EngineKind::Claude,
            tab_id: "tab-1".into(),
            binary: PathBuf::from("/usr/local/bin/claude"),
            cwd: PathBuf::from("/tmp/scratch"),
            attached_folder: None,
            use_host_config,
            model: None,
            mcp: McpEndpoint {
                url: "http://127.0.0.1:53111/mcp".into(),
                token: "s3cret-token".into(),
                shim_command: vec!["/Apps/Excalidraw".into(), "--mcp-shim".into()],
            },
            system_prompt: "You draw on an Excalidraw canvas.".into(),
            resume_id: None,
        }
    }

    fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
    }

    /// Adapter that has completed the handshake and started turn `t1`.
    fn started(fixture: &str) -> (ClaudeAdapter, Vec<AgentEvent>) {
        let mut a = ClaudeAdapter::new();
        a.start(&cfg(false));
        let mut events = a.on_line(fixture.lines().next().unwrap()).events;
        events.extend(a.prompt("t1", "hello").events);
        (a, events)
    }

    fn feed(a: &mut ClaudeAdapter, lines: &[&str]) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        for l in lines {
            let o = a.on_line(l);
            out.events.extend(o.events);
            out.writes.extend(o.writes);
        }
        out
    }

    fn parse(line: &str) -> Value {
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn launch_spec_is_always_sandboxed() {
        for host in [false, true] {
            let spec = ClaudeAdapter::new().launch_spec(&cfg(host));
            let args = &spec.args;
            assert_eq!(spec.program, PathBuf::from("/usr/local/bin/claude"));
            assert_eq!(arg_after(args, "--permission-prompt-tool"), Some("stdio"));
            assert_eq!(arg_after(args, "--permission-mode"), Some("default"));
            assert_eq!(arg_after(args, "--input-format"), Some("stream-json"));
            assert_eq!(arg_after(args, "--output-format"), Some("stream-json"));
            let disallowed = arg_after(args, "--disallowedTools").unwrap();
            for t in [
                "Bash",
                "Edit",
                "Write",
                "MultiEdit",
                "NotebookEdit",
                "PowerShell",
            ] {
                assert!(disallowed.split(',').any(|d| d == t), "{t} not disallowed");
            }
            let tools: Vec<&str> = arg_after(args, "--tools").unwrap().split(',').collect();
            assert!(tools.contains(&"ToolSearch"));
            for t in DISALLOWED_TOOLS {
                assert!(!tools.contains(t), "{t} must not be enabled");
            }
            assert_eq!(tools.contains(&"Skill"), host);
            assert_eq!(args.contains(&"--strict-mcp-config".to_string()), !host);
            assert_eq!(
                arg_after(args, "--setting-sources"),
                Some(if host { "user" } else { "" })
            );
            assert_eq!(
                arg_after(args, "--append-system-prompt"),
                Some("You draw on an Excalidraw canvas.")
            );
            for var in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
                assert!(spec.env_remove.iter().any(|e| e == var));
            }
            assert!(!args.iter().any(|a| a.contains("s3cret-token")));
            assert!(spec
                .env_set
                .contains(&(MCP_TOKEN_ENV.into(), "s3cret-token".into())));
            assert!(spec
                .env_set
                .contains(&(MCP_URL_ENV.into(), "http://127.0.0.1:53111/mcp".into())));
            assert_eq!(spec.cwd, PathBuf::from("/tmp/scratch"));
        }
    }

    #[test]
    fn mcp_config_uses_stdio_shim() {
        let v = parse(&mcp_config_json(&cfg(false)));
        let s = &v["mcpServers"]["excalidraw"];
        assert_eq!(s["type"], "stdio");
        assert_eq!(s["command"], "/Apps/Excalidraw");
        assert_eq!(s["args"], json!(["--mcp-shim"]));
    }

    #[test]
    fn mcp_config_falls_back_to_http_without_shim() {
        let mut c = cfg(false);
        c.mcp.shim_command.clear();
        let v = parse(&mcp_config_json(&c));
        let s = &v["mcpServers"]["excalidraw"];
        assert_eq!(s["type"], "http");
        assert_eq!(s["headers"]["Authorization"], "Bearer s3cret-token");
    }

    #[test]
    fn session_model_and_folder_flags() {
        let a = ClaudeAdapter::new();
        let mut c = cfg(false);
        let args = a.launch_spec(&c).args;
        let sid = arg_after(&args, "--session-id").unwrap();
        assert_eq!(sid.len(), 36);
        assert_eq!(&sid[14..15], "4");
        assert!(arg_after(&args, "--resume").is_none());
        assert!(arg_after(&args, "--model").is_none());
        assert!(arg_after(&args, "--add-dir").is_none());

        c.resume_id = Some("abc".into());
        c.model = Some("haiku".into());
        c.attached_folder = Some(PathBuf::from("/Users/user/notes"));
        let args = a.launch_spec(&c).args;
        assert_eq!(arg_after(&args, "--resume"), Some("abc"));
        assert!(arg_after(&args, "--session-id").is_none());
        assert_eq!(arg_after(&args, "--model"), Some("haiku"));
        assert_eq!(arg_after(&args, "--add-dir"), Some("/Users/user/notes"));
    }

    #[test]
    fn start_sends_initialize_and_ready_reports_session() {
        let mut a = ClaudeAdapter::new();
        let mut c = cfg(false);
        c.model = Some("haiku".into());
        let out = a.start(&c);
        assert!(out.events.is_empty());
        let init = parse(&out.writes[0]);
        assert_eq!(init["type"], "control_request");
        assert_eq!(init["request"]["subtype"], "initialize");
        let sid = arg_after(&a.launch_spec(&c).args, "--session-id")
            .unwrap()
            .to_string();
        let resp = json!({"type":"control_response","response":{"subtype":"success",
            "request_id": init["request_id"], "response":{"claude_code_version":"2.1.329",
            "models":[{"value":"haiku","resolvedModel":"claude-haiku-5-5"}],
            "account":{"subscriptionType":"Claude Pro","apiProvider":"firstParty"}}}});
        let ev = a.on_line(&resp.to_string()).events;
        assert_eq!(
            ev,
            vec![AgentEvent::Ready {
                engine: EngineKind::Claude,
                version: Some("2.1.329".into()),
                model: Some("claude-haiku-5-5".into()),
                engine_session_id: Some(sid),
            }]
        );
    }

    #[test]
    fn hi_fixture_streams_text_and_ends_turn() {
        let (mut a, events) = started(HI);
        assert!(matches!(events[0], AgentEvent::Ready { .. }));
        assert_eq!(
            events[1],
            AgentEvent::TurnStarted {
                turn_id: "t1".into()
            }
        );
        let lines: Vec<&str> = HI.lines().skip(1).collect();
        let out = feed(&mut a, &lines);
        assert!(out.writes.is_empty());
        let text: String = out
            .events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::TextDelta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text.trim(), "hi");
        match out.events.last().unwrap() {
            AgentEvent::TurnEnded {
                turn_id,
                stop_reason,
                usage,
            } => {
                assert_eq!(turn_id, "t1");
                assert_eq!(*stop_reason, StopReason::EndTurn);
                let u = usage.as_ref().unwrap();
                assert!(u.input_tokens.unwrap() > 0 && u.output_tokens.unwrap() > 0);
            }
            e => panic!("unexpected {e:?}"),
        }
    }

    #[test]
    fn canvas_tools_are_auto_approved_and_tool_search_hidden() {
        let (mut a, _) = started(CANVAS);
        let lines: Vec<&str> = CANVAS.lines().skip(1).collect();
        let out = feed(&mut a, &lines);
        assert!(!out
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::PermissionRequest { .. })));
        assert_eq!(out.writes.len(), 2);
        for w in &out.writes {
            let v = parse(w);
            assert_eq!(v["response"]["subtype"], "success");
            assert_eq!(v["response"]["response"]["behavior"], "allow");
            assert!(v["response"]["response"]["updatedInput"].is_object());
        }
        let calls: Vec<(&str, ToolSource, ToolCallStatus)> = out
            .events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCall {
                    name,
                    source,
                    status,
                    ..
                } => Some((name.as_str(), *source, *status)),
                _ => None,
            })
            .collect();
        use ToolCallStatus::*;
        assert_eq!(
            calls,
            vec![
                (
                    "mcp__excalidraw__get_scene_summary",
                    ToolSource::Canvas,
                    Running
                ),
                (
                    "mcp__excalidraw__get_scene_summary",
                    ToolSource::Canvas,
                    Completed
                ),
                ("mcp__excalidraw__add_elements", ToolSource::Canvas, Running),
                (
                    "mcp__excalidraw__add_elements",
                    ToolSource::Canvas,
                    Completed
                ),
            ]
        );
        assert!(matches!(
            out.events.last(),
            Some(AgentEvent::TurnEnded {
                stop_reason: StopReason::EndTurn,
                ..
            })
        ));
    }

    #[test]
    fn deny_fixture_round_trips_permission() {
        let (mut a, _) = started(DENY);
        let mut events = vec![];
        let mut writes = vec![];
        for line in DENY.lines().skip(1) {
            let out = a.on_line(line);
            for e in &out.events {
                if let AgentEvent::PermissionRequest {
                    request_id,
                    tool_name,
                    turn_id,
                    ..
                } = e
                {
                    assert_eq!(tool_name, "WebFetch");
                    assert_eq!(turn_id, "t1");
                    writes.extend(
                        a.respond_permission(request_id, PermissionDecision::Deny)
                            .writes,
                    );
                }
            }
            events.extend(out.events);
            writes.extend(out.writes);
        }
        assert_eq!(writes.len(), 1);
        let v = parse(&writes[0]);
        assert_eq!(
            v["response"]["request_id"],
            "5fe33f99-d337-4c35-9470-bdee02ed201a"
        );
        assert_eq!(v["response"]["response"]["behavior"], "deny");
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::ToolCall { name, status: ToolCallStatus::Failed, source: ToolSource::Builtin, .. }
                if name == "WebFetch"
        )));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::TurnEnded {
                stop_reason: StopReason::EndTurn,
                ..
            })
        ));
    }

    fn can_use_tool(id: &str, tool: &str) -> String {
        json!({"type":"control_request","request_id":id,"request":{"subtype":"can_use_tool",
            "tool_name":tool,"display_name":"Fetch","input":{"url":"https://example.com"},
            "tool_use_id":"toolu_x"}})
        .to_string()
    }

    #[test]
    fn allow_for_conversation_is_remembered() {
        let (mut a, _) = started(HI);
        let out = a.on_line(&can_use_tool("r1", "WebFetch"));
        assert!(out.writes.is_empty());
        assert!(matches!(
            &out.events[..],
            [AgentEvent::PermissionRequest { request_id, title, detail: Some(d), .. }]
                if request_id == "r1" && title == "Fetch" && d.contains("example.com")
        ));
        let w = a.respond_permission("r1", PermissionDecision::AllowForConversation);
        let v = parse(&w.writes[0]);
        assert_eq!(v["response"]["response"]["behavior"], "allow");
        assert_eq!(
            v["response"]["response"]["updatedInput"]["url"],
            "https://example.com"
        );
        // Unknown / already answered ids are ignored.
        assert!(a
            .respond_permission("r1", PermissionDecision::AllowOnce)
            .writes
            .is_empty());
        let out = a.on_line(&can_use_tool("r2", "WebFetch"));
        assert!(out.events.is_empty());
        assert_eq!(
            parse(&out.writes[0])["response"]["response"]["behavior"],
            "allow"
        );
        // AllowOnce is not remembered.
        a.on_line(&can_use_tool("r3", "WebSearch"));
        a.respond_permission("r3", PermissionDecision::AllowOnce);
        assert_eq!(a.on_line(&can_use_tool("r4", "WebSearch")).events.len(), 1);
    }

    #[test]
    fn cancelled_permission_request_is_dropped() {
        let (mut a, _) = started(HI);
        a.on_line(&can_use_tool("r1", "WebFetch"));
        a.on_line(r#"{"type":"control_cancel_request","request_id":"r1"}"#);
        assert!(a
            .respond_permission("r1", PermissionDecision::AllowOnce)
            .writes
            .is_empty());
    }

    #[test]
    fn interrupt_fixture_cancels_turn() {
        let (mut a, _) = started(INTERRUPT);
        a.on_line(&can_use_tool("r1", "WebFetch"));
        let out = a.cancel();
        assert_eq!(out.writes.len(), 2);
        assert_eq!(
            parse(&out.writes[0])["response"]["response"]["behavior"],
            "deny"
        );
        let int = parse(&out.writes[1]);
        assert_eq!(int["type"], "control_request");
        assert_eq!(int["request"]["subtype"], "interrupt");
        assert!(a.cancel().writes.is_empty(), "cancel is idempotent");
        let lines: Vec<&str> = INTERRUPT.lines().skip(1).collect();
        let out = feed(&mut a, &lines);
        assert!(!out
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::Error { .. })));
        assert!(matches!(
            out.events.last(),
            Some(AgentEvent::TurnEnded {
                stop_reason: StopReason::Cancelled,
                ..
            })
        ));
        assert!(a.cancel().writes.is_empty(), "no turn → nothing to cancel");
    }

    #[test]
    fn interrupt_result_without_local_cancel_is_cancelled() {
        let (mut a, _) = started(INTERRUPT);
        let lines: Vec<&str> = INTERRUPT.lines().skip(1).collect();
        let out = feed(&mut a, &lines);
        assert!(matches!(
            out.events.last(),
            Some(AgentEvent::TurnEnded {
                stop_reason: StopReason::Cancelled,
                ..
            })
        ));
    }

    #[test]
    fn not_logged_in_fixture_reports_auth_error() {
        let mut a = ClaudeAdapter::new();
        a.start(&cfg(false));
        let first = a.on_line(NOT_LOGGED_IN.lines().next().unwrap()).events;
        assert!(matches!(
            &first[..],
            [AgentEvent::Error {
                kind: ErrorKind::NotLoggedIn,
                fatal: true,
                ..
            }]
        ));
        a.prompt("t1", "hi");
        let lines: Vec<&str> = NOT_LOGGED_IN.lines().skip(1).collect();
        let out = feed(&mut a, &lines);
        assert!(!out.events.iter().any(|e| matches!(
            e,
            AgentEvent::Ready { .. } | AgentEvent::TextDelta { .. } | AgentEvent::Error { .. }
        )));
        assert!(matches!(
            out.events.last(),
            Some(AgentEvent::TurnEnded {
                stop_reason: StopReason::Error,
                ..
            })
        ));
    }

    #[test]
    fn mid_session_auth_failure_maps_assistant_error() {
        let (mut a, _) = started(HI);
        let out = feed(
            &mut a,
            &[
                r#"{"type":"assistant","error":"authentication_failed","parent_tool_use_id":null,"message":{"id":"m1","content":[{"type":"text","text":"Not logged in · Please run /login"}]}}"#,
                r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#,
            ],
        );
        assert_eq!(
            out.events,
            vec![
                AgentEvent::Error {
                    kind: ErrorKind::NotLoggedIn,
                    message: "Not logged in · Please run /login".into(),
                    fatal: true,
                },
                AgentEvent::TurnEnded {
                    turn_id: "t1".into(),
                    stop_reason: StopReason::Error,
                    usage: None,
                },
            ]
        );
    }

    #[test]
    fn rejected_rate_limit_is_quota_exceeded() {
        let (mut a, _) = started(HI);
        let allowed = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"five_hour"}}"#;
        assert!(a.on_line(allowed).events.is_empty());
        let overage = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","isUsingOverage":true}}"#;
        assert!(a.on_line(overage).events.is_empty());
        let rejected = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1795146600,"isUsingOverage":false}}"#;
        assert!(matches!(
            &a.on_line(rejected).events[..],
            [AgentEvent::Error { kind: ErrorKind::QuotaExceeded, fatal: false, message }]
                if message.contains("five_hour")
        ));
        let out = a.on_line(r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"limit"}"#);
        assert_eq!(out.events.len(), 1, "quota error is not reported twice");
    }

    #[test]
    fn result_subtypes_map_to_stop_reasons() {
        let cases = [
            (
                r#"{"type":"result","subtype":"success","is_error":false,"stop_reason":"refusal"}"#,
                StopReason::Refusal,
            ),
            (
                r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#,
                StopReason::MaxTurns,
            ),
            (
                r#"{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["boom"]}"#,
                StopReason::Error,
            ),
        ];
        for (line, expected) in cases {
            let (mut a, _) = started(HI);
            let out = a.on_line(line);
            assert!(
                matches!(out.events.last(), Some(AgentEvent::TurnEnded { stop_reason, .. }) if *stop_reason == expected),
                "{line}"
            );
        }
    }

    #[test]
    fn unknown_control_request_gets_error_response() {
        let (mut a, _) = started(HI);
        let out = a.on_line(
            r#"{"type":"control_request","request_id":"x1","request":{"subtype":"hook_callback"}}"#,
        );
        let v = parse(&out.writes[0]);
        assert_eq!(v["response"]["subtype"], "error");
        assert_eq!(v["response"]["request_id"], "x1");
    }

    #[test]
    fn stderr_login_hint_is_not_logged_in() {
        let mut a = ClaudeAdapter::new();
        assert!(a.on_stderr("some debug noise").events.is_empty());
        let ev = a.on_stderr("Invalid API key · Please run /login").events;
        assert!(matches!(
            &ev[..],
            [AgentEvent::Error {
                kind: ErrorKind::NotLoggedIn,
                ..
            }]
        ));
        assert!(a.on_stderr("Please run /login").events.is_empty());
    }

    #[test]
    fn garbage_and_subagent_lines_are_ignored() {
        let (mut a, _) = started(HI);
        assert_eq!(a.on_line("not json"), AdapterOutput::default());
        let sub = r#"{"type":"assistant","parent_tool_use_id":"toolu_parent","message":{"id":"m9","content":[{"type":"text","text":"subagent"}]}}"#;
        assert!(a.on_line(sub).events.is_empty());
    }
}
