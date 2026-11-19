//! Codex lane: drives `codex app-server` (JSON-RPC 2.0 over stdio, NDJSON framing).
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
//! (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `provider/CodexMcpElicitation.ts`.)
//!
//! Session flow (sans-IO; see [`EngineAdapter`]):
//! `initialize` → `initialized` + `account/read` → [`config/read` when host config is off] →
//! `thread/start` | `thread/resume` → `Ready` → `turn/start` per prompt → streamed notifications.
//!
//! Safety (SEC-3/SEC-6): the sandbox is read-only at every layer: `-c sandbox_mode` on the
//! command line, `sandbox` on the thread, and `sandboxPolicy` on every turn. Approval policy is
//! `on-request`. Our canvas MCP server is pre-approved (`default_tools_approval_mode = "approve"`,
//! plus auto-accept of any elicitation it still raises); every other approval becomes an
//! [`AgentEvent::PermissionRequest`].
//!
//! Host config (D-AI5) off: Codex merges thread `config` overrides recursively, so
//! `mcp_servers = {}` cannot remove the user's servers. Instead we `config/read` the effective
//! config and set `mcp_servers.<name>.enabled = false` for every server but ours, disable
//! apps/plugins/skills, and set `project_doc_max_bytes = 0` (no AGENTS.md from the project).
//! The user's global `$CODEX_HOME/AGENTS.md` still applies: isolating CODEX_HOME would also
//! drop their login, so this is best-effort.
//!
//! `codex exec --json` fallback: a one-shot-per-turn mode for Codex builds without
//! `app-server`. It would be a second `EngineAdapter` (`CodexExecAdapter`) whose `launch_spec`
//! is chosen by `detect` when `version < CODEX_MIN_VERSION`; each `prompt` would need a fresh
//! process (`codex exec --json --sandbox read-only resume <thread>`), which the manager's
//! one-process-per-session model doesn't support yet. Not implemented.
mod errors;
pub mod protocol;
#[cfg(test)]
mod tests;

use super::adapter::{
    AdapterOutput, EngineAdapter, LaunchSpec, McpEndpoint, SessionConfig, MCP_SERVER_NAME,
    MCP_TOKEN_ENV, MCP_URL_ENV,
};
use super::events::{
    AgentEvent, EngineKind, ErrorKind, PermissionDecision, PlanEntry, StopReason, ToolCallStatus,
    ToolSource, Usage,
};
use protocol::*;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// Oldest Codex CLI whose `app-server` protocol matches [`protocol`] (thread/turn v2 API,
/// `approvalsReviewer`, `mcpServer/elicitation/request`, `item/permissions/requestApproval`).
/// Verified against T3 Code's recorded 0.156.1 transcripts.
pub const CODEX_MIN_VERSION: &str = "0.156.0";

const APPROVAL_POLICY: &str = "on-request";
const APPROVALS_REVIEWER: &str = "user";
const SANDBOX_MODE: &str = "read-only";
const CLIENT_NAME: &str = "excalidraw_desktop";
const MAX_TOOL_OUTPUT: usize = 8 * 1024;
/// Env vars that would silently switch Codex from the user's ChatGPT plan to API billing.
const BILLING_ENV_VARS: [&str; 2] = ["OPENAI_API_KEY", "CODEX_API_KEY"];

#[derive(Debug, Clone, PartialEq)]
enum Pending {
    Initialize,
    AccountRead,
    ConfigRead,
    ThreadStart,
    ThreadResume,
    TurnStart { app_turn: String },
    TurnInterrupt,
}

#[derive(Debug, Default)]
struct ActiveTurn {
    app_turn_id: String,
    codex_turn_id: Option<String>,
    /// Prompt held until the thread exists.
    queued_text: Option<String>,
    cancel_requested: bool,
    interrupt_sent: bool,
    usage: Option<Usage>,
    error_emitted: bool,
    text_emitted: bool,
    saw_summary: bool,
    delta_items: HashSet<String>,
}

#[derive(Debug, Clone)]
enum ApprovalKind {
    Command,
    FileChange,
    Permissions { requested: Value },
    McpToolCall { persist_session: bool },
    ExecV1,
    PatchV1,
}

#[derive(Debug, Clone)]
struct PendingApproval {
    rpc_id: Value,
    kind: ApprovalKind,
    allowance_key: String,
}

#[derive(Debug, Default)]
pub struct CodexAdapter {
    next_id: u64,
    pending: HashMap<u64, Pending>,
    cwd: String,
    model: Option<String>,
    system_prompt: Option<String>,
    use_host_config: bool,
    mcp: Option<McpEndpoint>,
    resume_id: Option<String>,
    /// Host MCP servers disabled via `config/read` (host config off).
    disabled_servers: Vec<String>,
    version: Option<String>,
    thread_id: Option<String>,
    dead: bool,
    turn: Option<ActiveTurn>,
    approval_seq: u64,
    approvals: HashMap<String, PendingApproval>,
    /// Keys granted with "allow for conversation"; matching requests are auto-accepted.
    allowances: HashSet<String>,
    stderr_reported: Vec<ErrorKind>,
}

impl CodexAdapter {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            ..Self::default()
        }
    }

    /// Codex thread id once the thread exists; persist it to resume later via `resume_id`.
    pub fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }

    fn request(&mut self, method: &str, params: impl serde::Serialize, kind: Pending) -> String {
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, kind);
        request_line(id, method, params)
    }

    fn fatal(&mut self, out: &mut AdapterOutput, kind: ErrorKind, message: impl Into<String>) {
        self.dead = true;
        out.events.push(AgentEvent::Error {
            kind,
            message: message.into(),
            fatal: true,
        });
    }

    /// Thread-level `config` overrides (dotted keys, `-c` semantics).
    fn thread_config(&self, disable_servers: &[String]) -> Map<String, Value> {
        let mut servers = Map::new();
        if let Some(mcp) = &self.mcp {
            servers.insert(MCP_SERVER_NAME.to_string(), excalidraw_server(mcp));
        }
        for name in disable_servers {
            if name != MCP_SERVER_NAME {
                servers.insert(name.clone(), json!({ "enabled": false }));
            }
        }
        let mut cfg = Map::new();
        // One nested value (not `mcp_servers.<name>` keys): override paths split on '.', so
        // server names containing dots would otherwise be mangled.
        cfg.insert("mcp_servers".into(), Value::Object(servers));
        cfg.insert("tools.update_plan.enabled".into(), json!(true));
        cfg.insert("mcp_optional_startup_grace_ms".into(), json!(10_000));
        if !self.use_host_config {
            cfg.insert("project_doc_max_bytes".into(), json!(0));
            cfg.insert("features.apps".into(), json!(false));
            cfg.insert("features.plugins".into(), json!(false));
            cfg.insert("skills.include_instructions".into(), json!(false));
            cfg.insert("skills.bundled.enabled".into(), json!(false));
        }
        cfg
    }

    fn open_thread(&mut self, out: &mut AdapterOutput, disable_servers: &[String], resume: bool) {
        let resume_id = if resume { self.resume_id.clone() } else { None };
        let params = ThreadParams {
            thread_id: resume_id.clone(),
            approval_policy: APPROVAL_POLICY,
            approvals_reviewer: APPROVALS_REVIEWER,
            sandbox: SANDBOX_MODE,
            cwd: self.cwd.clone(),
            model: self.model.clone(),
            developer_instructions: self.system_prompt.clone(),
            config: self.thread_config(disable_servers),
        };
        let line = match resume_id {
            Some(_) => self.request(M_THREAD_RESUME, &params, Pending::ThreadResume),
            None => self.request(M_THREAD_START, &params, Pending::ThreadStart),
        };
        out.writes.push(line);
    }

    fn send_turn(&mut self, out: &mut AdapterOutput) {
        let (Some(thread_id), Some(turn)) = (self.thread_id.clone(), self.turn.as_mut()) else {
            return;
        };
        let Some(text) = turn.queued_text.take() else {
            return;
        };
        let app_turn = turn.app_turn_id.clone();
        let params = TurnStartParams {
            thread_id,
            input: vec![UserInput::Text { text }],
            approval_policy: APPROVAL_POLICY,
            approvals_reviewer: APPROVALS_REVIEWER,
            sandbox_policy: SandboxPolicy::ReadOnly {
                network_access: false,
            },
            cwd: self.cwd.clone(),
            model: self.model.clone(),
        };
        let line = self.request(M_TURN_START, params, Pending::TurnStart { app_turn });
        out.writes.push(line);
    }

    fn send_interrupt(&mut self, out: &mut AdapterOutput) {
        let (Some(thread_id), Some(turn)) = (self.thread_id.clone(), self.turn.as_mut()) else {
            return;
        };
        let Some(turn_id) = turn.codex_turn_id.clone() else {
            return;
        };
        if turn.interrupt_sent {
            return;
        }
        turn.interrupt_sent = true;
        let line = self.request(
            M_TURN_INTERRUPT,
            TurnInterruptParams { thread_id, turn_id },
            Pending::TurnInterrupt,
        );
        out.writes.push(line);
    }

    fn end_turn(&mut self, out: &mut AdapterOutput, stop_reason: StopReason) {
        if let Some(turn) = self.turn.take() {
            out.events.push(AgentEvent::TurnEnded {
                turn_id: turn.app_turn_id,
                stop_reason,
                usage: turn.usage,
            });
        }
        // Codex resolves its own outstanding requests when a turn ends.
        self.approvals.clear();
    }

    /// True if a notification for `thread_id` belongs to our main thread (not a sub-agent).
    fn is_ours(&self, thread_id: Option<&str>) -> bool {
        match (thread_id, self.thread_id.as_deref()) {
            (Some(t), Some(ours)) => t == ours,
            _ => true,
        }
    }

    /// The active app turn for a notification, if it belongs to the current turn.
    fn turn_for(
        &mut self,
        thread_id: Option<&str>,
        turn_id: Option<&str>,
    ) -> Option<&mut ActiveTurn> {
        if !self.is_ours(thread_id) {
            return None;
        }
        let turn = self.turn.as_mut()?;
        match (turn_id, turn.codex_turn_id.as_deref()) {
            (Some(t), Some(ours)) if t != ours => None,
            _ => Some(turn),
        }
    }

    // ---- responses ----

    fn on_response(&mut self, out: &mut AdapterOutput, id: Value, result: Result<Value, RpcError>) {
        let Some(kind) = id.as_u64().and_then(|n| self.pending.remove(&n)) else {
            log::debug!("codex: response for unknown id {id}");
            return;
        };
        match kind {
            Pending::Initialize => self.on_initialized(out, result),
            Pending::AccountRead => match result {
                Ok(v) => {
                    let r: AccountReadResult = serde_json::from_value(v).unwrap_or_default();
                    if r.account.is_none() && r.requires_openai_auth {
                        self.fatal(
                            out,
                            ErrorKind::NotLoggedIn,
                            "Codex CLI is not signed in. Run `codex login` and try again.",
                        );
                    }
                }
                Err(e) => log::warn!("codex: account/read failed: {}", e.message),
            },
            Pending::ConfigRead => {
                let servers = match result {
                    Ok(v) => v
                        .pointer("/config/mcp_servers")
                        .and_then(Value::as_object)
                        .map(|m| m.keys().cloned().collect())
                        .unwrap_or_default(),
                    Err(e) => {
                        log::warn!(
                            "codex: config/read failed, cannot disable host MCP servers: {}",
                            e.message
                        );
                        Vec::new()
                    }
                };
                self.disabled_servers = servers.clone();
                self.open_thread(out, &servers, true);
            }
            Pending::ThreadStart | Pending::ThreadResume => {
                let resumed = kind == Pending::ThreadResume;
                self.on_thread_result(out, result, resumed);
            }
            Pending::TurnStart { app_turn } => self.on_turn_start_result(out, &app_turn, result),
            Pending::TurnInterrupt => {
                if let Err(e) = result {
                    log::warn!("codex: turn/interrupt failed: {}", e.message);
                }
            }
        }
    }

    fn on_initialized(&mut self, out: &mut AdapterOutput, result: Result<Value, RpcError>) {
        let r: InitializeResult = match result {
            Ok(v) => serde_json::from_value(v).unwrap_or_default(),
            Err(e) => {
                return self.fatal(
                    out,
                    ErrorKind::Protocol,
                    format!("Codex app-server initialize failed: {}", e.message),
                )
            }
        };
        self.version = r.user_agent.as_deref().and_then(version_from_user_agent);
        if let Some(v) = &self.version {
            if version_lt(v, CODEX_MIN_VERSION) {
                return self.fatal(
                    out,
                    ErrorKind::UnsupportedVersion,
                    format!(
                        "Codex CLI {v} is too old; version {CODEX_MIN_VERSION} or newer is required. Run `codex update` (or reinstall) and try again."
                    ),
                );
            }
        } else {
            log::warn!(
                "codex: could not parse version from userAgent {:?}",
                r.user_agent
            );
        }
        out.writes.push(notification_line(M_INITIALIZED));
        let line = self.request(M_ACCOUNT_READ, json!({}), Pending::AccountRead);
        out.writes.push(line);
        if self.use_host_config {
            self.open_thread(out, &[], true);
        } else {
            let params = ConfigReadParams {
                cwd: self.cwd.clone(),
                include_layers: false,
            };
            let line = self.request(M_CONFIG_READ, params, Pending::ConfigRead);
            out.writes.push(line);
        }
    }

    fn on_thread_result(
        &mut self,
        out: &mut AdapterOutput,
        result: Result<Value, RpcError>,
        resumed: bool,
    ) {
        match result.map(serde_json::from_value::<ThreadResult>) {
            Ok(Ok(r)) => {
                out.events.push(AgentEvent::Ready {
                    engine: EngineKind::Codex,
                    version: self.version.clone(),
                    model: r.model.or_else(|| self.model.clone()),
                    engine_session_id: Some(r.thread.id.clone()),
                });
                self.thread_id = Some(r.thread.id);
                if !self.dead {
                    self.send_turn(out);
                }
            }
            Ok(Err(e)) => self.fatal(
                out,
                ErrorKind::Protocol,
                format!("Unexpected thread response from Codex: {e}"),
            ),
            Err(e) if errors::is_writer_conflict(&e) => {
                self.fatal(out, ErrorKind::Other, errors::WRITER_CONFLICT_MESSAGE)
            }
            Err(e) if resumed => {
                // Unknown/expired thread: start fresh rather than failing the tab.
                log::warn!(
                    "codex: thread/resume failed ({}); starting a new thread",
                    e.message
                );
                let disable = self.disabled_servers.clone();
                self.open_thread(out, &disable, false);
            }
            Err(e) => {
                let kind = errors::classify(&e.message, None);
                self.fatal(
                    out,
                    kind,
                    format!("Codex could not start a conversation: {}", e.message),
                );
            }
        }
    }

    fn on_turn_start_result(
        &mut self,
        out: &mut AdapterOutput,
        app_turn: &str,
        result: Result<Value, RpcError>,
    ) {
        let matches = self
            .turn
            .as_ref()
            .is_some_and(|t| t.app_turn_id == app_turn);
        match result {
            Ok(v) => {
                let Ok(r) = serde_json::from_value::<TurnResult>(v) else {
                    return;
                };
                if matches {
                    self.adopt_turn_id(out, r.turn.id);
                }
            }
            Err(e) => {
                if !matches {
                    return;
                }
                let (kind, message) = if errors::is_writer_conflict(&e) {
                    (
                        ErrorKind::Other,
                        errors::WRITER_CONFLICT_MESSAGE.to_string(),
                    )
                } else {
                    (errors::classify(&e.message, None), e.message)
                };
                out.events.push(AgentEvent::Error {
                    kind,
                    message,
                    fatal: false,
                });
                self.end_turn(out, StopReason::Error);
            }
        }
    }

    fn adopt_turn_id(&mut self, out: &mut AdapterOutput, codex_turn_id: String) {
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        if turn.codex_turn_id.is_none() {
            turn.codex_turn_id = Some(codex_turn_id);
            if turn.cancel_requested {
                self.send_interrupt(out);
            }
        }
    }

    // ---- notifications ----

    fn on_notification(&mut self, out: &mut AdapterOutput, method: &str, params: Value) {
        match method {
            N_TURN_STARTED => {
                if let Ok(n) = serde_json::from_value::<TurnNotification>(params) {
                    if self.is_ours(n.thread_id.as_deref()) && self.turn.is_some() {
                        self.adopt_turn_id(out, n.turn.id);
                    }
                }
            }
            N_TURN_COMPLETED => {
                if let Ok(n) = serde_json::from_value::<TurnNotification>(params) {
                    self.on_turn_completed(out, n);
                }
            }
            N_AGENT_MESSAGE_DELTA => {
                let Ok(n) = serde_json::from_value::<DeltaNotification>(params) else {
                    return;
                };
                let Some(turn) = self.turn_for(n.thread_id.as_deref(), n.turn_id.as_deref()) else {
                    return;
                };
                if n.delta.is_empty() {
                    return;
                }
                let item = n.item_id.unwrap_or_default();
                let mut text = String::new();
                if turn.delta_items.insert(item) && turn.text_emitted {
                    text.push_str("\n\n");
                }
                text.push_str(&n.delta);
                turn.text_emitted = true;
                out.events.push(AgentEvent::TextDelta {
                    turn_id: turn.app_turn_id.clone(),
                    text,
                });
            }
            N_REASONING_SUMMARY_DELTA | N_REASONING_TEXT_DELTA | N_REASONING_SUMMARY_PART => {
                let Ok(n) = serde_json::from_value::<DeltaNotification>(params) else {
                    return;
                };
                let Some(turn) = self.turn_for(n.thread_id.as_deref(), n.turn_id.as_deref()) else {
                    return;
                };
                let text = match method {
                    N_REASONING_SUMMARY_PART if n.summary_index.unwrap_or(0) > 0 => {
                        "\n\n".to_string()
                    }
                    N_REASONING_SUMMARY_PART => return,
                    N_REASONING_SUMMARY_DELTA => {
                        turn.saw_summary = true;
                        n.delta
                    }
                    // Raw reasoning only when the model provides no summary (avoids duplicates).
                    _ if turn.saw_summary => return,
                    _ => n.delta,
                };
                if !text.is_empty() {
                    out.events.push(AgentEvent::ThinkingDelta {
                        turn_id: turn.app_turn_id.clone(),
                        text,
                    });
                }
            }
            N_ITEM_STARTED | N_ITEM_COMPLETED => {
                let Ok(n) = serde_json::from_value::<ItemNotification>(params) else {
                    return;
                };
                let completed = method == N_ITEM_COMPLETED;
                let Some(turn) = self.turn_for(n.thread_id.as_deref(), n.turn_id.as_deref()) else {
                    return;
                };
                let app_turn = turn.app_turn_id.clone();
                if let ThreadItem::AgentMessage { id, text } = &n.item {
                    // Messages that arrived whole (no deltas) still need to be shown.
                    if completed && !text.is_empty() && !turn.delta_items.contains(id) {
                        turn.delta_items.insert(id.clone());
                        let sep = if turn.text_emitted { "\n\n" } else { "" };
                        turn.text_emitted = true;
                        out.events.push(AgentEvent::TextDelta {
                            turn_id: app_turn,
                            text: format!("{sep}{text}"),
                        });
                    }
                    return;
                }
                if let Some(ev) = tool_call_event(&app_turn, &n.item, completed) {
                    out.events.push(ev);
                }
            }
            N_TURN_PLAN_UPDATED => {
                let Ok(n) = serde_json::from_value::<PlanNotification>(params) else {
                    return;
                };
                let Some(turn) = self.turn_for(n.thread_id.as_deref(), n.turn_id.as_deref()) else {
                    return;
                };
                out.events.push(AgentEvent::Plan {
                    turn_id: turn.app_turn_id.clone(),
                    entries: n
                        .plan
                        .into_iter()
                        .map(|s| PlanEntry {
                            content: s.step,
                            status: plan_status(&s.status),
                        })
                        .collect(),
                });
            }
            N_TOKEN_USAGE => {
                let Ok(n) = serde_json::from_value::<TokenUsageNotification>(params) else {
                    return;
                };
                let Some(turn) = self.turn_for(n.thread_id.as_deref(), n.turn_id.as_deref()) else {
                    return;
                };
                if let Some(last) = n.token_usage.last {
                    let u = turn.usage.get_or_insert_with(Usage::default);
                    u.input_tokens =
                        Some(u.input_tokens.unwrap_or(0) + last.input_tokens.unwrap_or(0));
                    u.output_tokens =
                        Some(u.output_tokens.unwrap_or(0) + last.output_tokens.unwrap_or(0));
                }
            }
            N_ERROR => {
                let Ok(n) = serde_json::from_value::<ErrorNotification>(params) else {
                    return;
                };
                if n.will_retry || !self.is_ours(n.thread_id.as_deref()) {
                    return;
                }
                if let Some(turn) = self.turn_for(n.thread_id.as_deref(), n.turn_id.as_deref()) {
                    turn.error_emitted = true;
                }
                out.events.push(AgentEvent::Error {
                    kind: errors::classify_turn_error(&n.error),
                    message: errors::turn_error_message(&n.error),
                    fatal: false,
                });
            }
            N_SERVER_REQUEST_RESOLVED => {
                if let Some(rid) = params.get("requestId") {
                    self.approvals.retain(|_, a| &a.rpc_id != rid);
                }
            }
            _ => {}
        }
    }

    fn on_turn_completed(&mut self, out: &mut AdapterOutput, n: TurnNotification) {
        let Some(turn) = self.turn_for(n.thread_id.as_deref(), Some(&n.turn.id)) else {
            return;
        };
        let error_emitted = turn.error_emitted;
        let cancelled = turn.cancel_requested;
        let stop = match n.turn.status.as_deref() {
            Some("interrupted") => StopReason::Cancelled,
            Some("failed") => {
                if !error_emitted {
                    let err = n.turn.error.clone().unwrap_or_else(|| TurnError {
                        message: "Codex turn failed.".into(),
                        ..TurnError::default()
                    });
                    out.events.push(AgentEvent::Error {
                        kind: errors::classify_turn_error(&err),
                        message: errors::turn_error_message(&err),
                        fatal: false,
                    });
                }
                errors::stop_reason_for_failure(n.turn.error.as_ref())
            }
            _ if cancelled => StopReason::Cancelled,
            _ => StopReason::EndTurn,
        };
        self.end_turn(out, stop);
    }

    // ---- server requests ----

    fn on_server_request(
        &mut self,
        out: &mut AdapterOutput,
        id: Value,
        method: &str,
        params: Value,
    ) {
        let (kind, key, tool_name, title, detail) = match method {
            R_COMMAND_APPROVAL => {
                let p: CommandApprovalParams = serde_json::from_value(params).unwrap_or_default();
                let cmd = p.command.unwrap_or_default();
                (
                    ApprovalKind::Command,
                    format!("command:{cmd}"),
                    "shell".to_string(),
                    format!("Run command: {cmd}"),
                    join_detail([p.reason, p.cwd.map(|c| format!("in {c}"))]),
                )
            }
            R_EXEC_APPROVAL_V1 => {
                let p: ExecApprovalV1Params = serde_json::from_value(params).unwrap_or_default();
                let cmd = p.command.join(" ");
                (
                    ApprovalKind::ExecV1,
                    format!("command:{cmd}"),
                    "shell".to_string(),
                    format!("Run command: {cmd}"),
                    join_detail([p.reason, p.cwd.map(|c| format!("in {c}"))]),
                )
            }
            R_FILE_CHANGE_APPROVAL => {
                let p: FileChangeApprovalParams =
                    serde_json::from_value(params).unwrap_or_default();
                let root = p.grant_root.clone().unwrap_or_default();
                (
                    ApprovalKind::FileChange,
                    format!("fileChange:{root}"),
                    "apply_patch".to_string(),
                    "Edit files".to_string(),
                    join_detail([
                        p.reason,
                        p.grant_root.map(|r| format!("write access to {r}")),
                    ]),
                )
            }
            R_APPLY_PATCH_APPROVAL_V1 => {
                let p: ApplyPatchApprovalV1Params =
                    serde_json::from_value(params).unwrap_or_default();
                let root = p.grant_root.clone().unwrap_or_default();
                let files: Vec<&str> = p.file_changes.keys().map(String::as_str).collect();
                (
                    ApprovalKind::PatchV1,
                    format!("fileChange:{root}"),
                    "apply_patch".to_string(),
                    "Edit files".to_string(),
                    join_detail([p.reason, Some(files.join("\n")).filter(|s| !s.is_empty())]),
                )
            }
            R_PERMISSIONS_APPROVAL => {
                let p: PermissionsApprovalParams =
                    serde_json::from_value(params).unwrap_or_default();
                (
                    ApprovalKind::Permissions {
                        requested: p.permissions.clone(),
                    },
                    format!("permissions:{}", p.permissions),
                    "permissions".to_string(),
                    "Grant additional permissions".to_string(),
                    join_detail([p.reason, Some(p.permissions.to_string())]),
                )
            }
            R_MCP_ELICITATION => {
                let p: McpElicitationParams = serde_json::from_value(params).unwrap_or_default();
                match self.mcp_elicitation(out, &id, p) {
                    Some(t) => t,
                    None => return,
                }
            }
            R_USER_INPUT => {
                // No free-form question UI; an empty answer lets the agent continue.
                out.writes
                    .push(response_line(&id, json!({ "answers": {} })));
                return;
            }
            _ => {
                log::debug!("codex: unsupported server request {method}");
                out.writes.push(error_response_line(
                    &id,
                    RPC_METHOD_NOT_FOUND,
                    &format!("{method} is not supported by Excalidraw Desktop"),
                ));
                return;
            }
        };
        if self.allowances.contains(&key) {
            out.writes.push(response_line(
                &id,
                approval_response(&kind, PermissionDecision::AllowForConversation),
            ));
            return;
        }
        self.approval_seq += 1;
        let request_id = format!("codex-approval-{}", self.approval_seq);
        let turn_id = self
            .turn
            .as_ref()
            .map(|t| t.app_turn_id.clone())
            .unwrap_or_default();
        self.approvals.insert(
            request_id.clone(),
            PendingApproval {
                rpc_id: id,
                kind,
                allowance_key: key,
            },
        );
        out.events.push(AgentEvent::PermissionRequest {
            turn_id,
            request_id,
            tool_name,
            title,
            detail,
        });
    }

    /// Returns the approval card fields, or `None` once answered automatically.
    fn mcp_elicitation(
        &mut self,
        out: &mut AdapterOutput,
        id: &Value,
        p: McpElicitationParams,
    ) -> Option<(ApprovalKind, String, String, String, Option<String>)> {
        let meta = p.meta.unwrap_or(Value::Null);
        let persist_session = match meta.get(META_PERSIST) {
            Some(Value::String(s)) => s == META_PERSIST_SESSION,
            Some(Value::Array(a)) => a.iter().any(|v| v == META_PERSIST_SESSION),
            _ => false,
        };
        let is_tool_approval = meta.get(META_APPROVAL_KIND).and_then(Value::as_str)
            == Some(META_APPROVAL_KIND_MCP_TOOL_CALL);
        if p.server_name == MCP_SERVER_NAME {
            // Canvas tools are pre-approved (FR-31).
            let kind = ApprovalKind::McpToolCall { persist_session };
            out.writes.push(response_line(
                id,
                approval_response(&kind, PermissionDecision::AllowForConversation),
            ));
            return None;
        }
        if !is_tool_approval || p.mode.as_deref() == Some("url") {
            log::warn!(
                "codex: declining {} elicitation from MCP server {:?} (no form UI)",
                p.mode.as_deref().unwrap_or("form"),
                p.server_name
            );
            out.writes
                .push(response_line(id, json!({ "action": "cancel" })));
            return None;
        }
        let tool = meta
            .get(META_TOOL_NAME)
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let title = if p.message.trim().is_empty() {
            format!("Use {tool} from {}", p.server_name)
        } else {
            p.message.clone()
        };
        let detail = meta
            .get("tool_params")
            .filter(|v| !v.is_null())
            .map(|v| truncate(&v.to_string(), MAX_TOOL_OUTPUT));
        Some((
            ApprovalKind::McpToolCall { persist_session },
            format!("mcp:{}/{tool}", p.server_name),
            format!("mcp__{}__{tool}", p.server_name),
            title,
            detail,
        ))
    }
}

fn excalidraw_server(mcp: &McpEndpoint) -> Value {
    let mut server = if !mcp.url.is_empty() {
        // Token stays in the process env (LaunchSpec.env_set), never in argv or the thread
        // config Codex persists to disk.
        json!({ "url": mcp.url, "bearer_token_env_var": MCP_TOKEN_ENV })
    } else {
        let (command, args) = mcp
            .shim_command
            .split_first()
            .map_or((String::new(), &[][..]), |(c, a)| (c.clone(), a));
        json!({
            "command": command,
            "args": args,
            // Forwarded from Codex's own env by name (values set in LaunchSpec.env_set).
            "env_vars": [MCP_URL_ENV, MCP_TOKEN_ENV],
        })
    };
    let obj = server.as_object_mut().expect("object");
    obj.insert("default_tools_approval_mode".into(), json!("approve"));
    obj.insert("startup_timeout_sec".into(), json!(20));
    obj.insert("tool_timeout_sec".into(), json!(120));
    server
}

fn approval_response(kind: &ApprovalKind, decision: PermissionDecision) -> Value {
    use PermissionDecision::*;
    match kind {
        ApprovalKind::Command | ApprovalKind::FileChange => json!({
            "decision": match decision {
                AllowOnce => "accept",
                AllowForConversation => "acceptForSession",
                Deny => "decline",
            }
        }),
        ApprovalKind::ExecV1 | ApprovalKind::PatchV1 => match decision {
            AllowOnce => json!({ "decision": "approved" }),
            AllowForConversation => json!({ "decision": "approved_for_session" }),
            Deny => {
                json!({ "decision": { "denied": { "rejection": "The user declined this request." } } })
            }
        },
        ApprovalKind::Permissions { requested } => match decision {
            AllowOnce => json!({ "permissions": requested, "scope": "turn" }),
            AllowForConversation => json!({ "permissions": requested, "scope": "session" }),
            Deny => json!({ "permissions": {}, "scope": "turn" }),
        },
        ApprovalKind::McpToolCall { persist_session } => match decision {
            AllowForConversation if *persist_session => {
                json!({ "action": "accept", "content": {}, "_meta": { META_PERSIST: META_PERSIST_SESSION } })
            }
            AllowOnce | AllowForConversation => json!({ "action": "accept", "content": {} }),
            Deny => json!({ "action": "decline" }),
        },
    }
}

fn tool_call_event(turn_id: &str, item: &ThreadItem, completed: bool) -> Option<AgentEvent> {
    let status_of = |s: &Option<String>| match s.as_deref() {
        Some("failed" | "declined") => ToolCallStatus::Failed,
        Some("completed") => ToolCallStatus::Completed,
        Some("inProgress") => ToolCallStatus::Running,
        _ if completed => ToolCallStatus::Completed,
        _ => ToolCallStatus::Running,
    };
    let ev = |call_id: &str, name: String, title: Option<String>, source, status, input, output| {
        AgentEvent::ToolCall {
            turn_id: turn_id.to_string(),
            call_id: call_id.to_string(),
            name,
            title,
            source,
            status,
            input,
            output,
        }
    };
    Some(match item {
        ThreadItem::CommandExecution {
            id,
            command,
            status,
            aggregated_output,
        } => ev(
            id,
            "shell".into(),
            Some(command.clone()),
            ToolSource::Builtin,
            status_of(status),
            Some(json!({ "command": command })),
            aggregated_output
                .as_deref()
                .filter(|_| completed)
                .map(|o| truncate(o, MAX_TOOL_OUTPUT)),
        ),
        ThreadItem::FileChange {
            id,
            changes,
            status,
        } => {
            let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
            ev(
                id,
                "apply_patch".into(),
                Some(format!("Edit {}", paths.join(", "))),
                ToolSource::Builtin,
                status_of(status),
                Some(json!({ "paths": paths })),
                None,
            )
        }
        ThreadItem::McpToolCall {
            id,
            server,
            tool,
            arguments,
            status,
            result,
            error,
        } => {
            let output = match (error, result) {
                (Some(e), _) if !e.message.is_empty() => {
                    Some(truncate(&e.message, MAX_TOOL_OUTPUT))
                }
                (_, Some(r)) if completed => {
                    let text: Vec<&str> = r
                        .content
                        .iter()
                        .filter_map(|c| c.get("text").and_then(Value::as_str))
                        .collect();
                    Some(truncate(&text.join("\n"), MAX_TOOL_OUTPUT)).filter(|s| !s.is_empty())
                }
                _ => None,
            };
            let source = if server == MCP_SERVER_NAME {
                ToolSource::Canvas
            } else {
                ToolSource::Host
            };
            let status = match status_of(status) {
                ToolCallStatus::Completed if error.is_some() => ToolCallStatus::Failed,
                s => s,
            };
            ev(
                id,
                format!("mcp__{server}__{tool}"),
                Some(tool.clone()),
                source,
                status,
                Some(arguments.clone()).filter(|a| !a.is_null()),
                output,
            )
        }
        ThreadItem::WebSearch { id, query } => ev(
            id,
            "web_search".into(),
            Some(query.clone()).filter(|q| !q.is_empty()),
            ToolSource::Builtin,
            if completed {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::Running
            },
            Some(json!({ "query": query })),
            None,
        ),
        _ => return None,
    })
}

fn plan_status(s: &str) -> String {
    match s {
        "inProgress" | "in_progress" => "in_progress",
        "completed" => "completed",
        _ => "pending",
    }
    .to_string()
}

fn join_detail<const N: usize>(parts: [Option<String>; N]) -> Option<String> {
    let parts: Vec<String> = parts
        .into_iter()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// `"codex_cli_rs/0.156.1 (Mac OS 15.5.0; arm64) ..."` → `"0.156.1"`.
pub fn version_from_user_agent(ua: &str) -> Option<String> {
    let v = ua.split_once('/')?.1.split_whitespace().next()?;
    v.chars().next()?.is_ascii_digit().then(|| v.to_string())
}

/// Numeric dotted compare; pre-release suffixes (`-alpha.1`) are ignored.
pub fn version_lt(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split(['-', '+'])
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(a), parse(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x < y;
        }
    }
    false
}

impl EngineAdapter for CodexAdapter {
    fn kind(&self) -> EngineKind {
        EngineKind::Codex
    }

    fn launch_spec(&self, cfg: &SessionConfig) -> LaunchSpec {
        let mut env_set = vec![(MCP_TOKEN_ENV.to_string(), cfg.mcp.token.clone())];
        if !cfg.mcp.url.is_empty() {
            env_set.push((MCP_URL_ENV.to_string(), cfg.mcp.url.clone()));
        }
        LaunchSpec {
            program: cfg.binary.clone(),
            args: vec![
                "app-server".into(),
                "-c".into(),
                format!("sandbox_mode=\"{SANDBOX_MODE}\""),
                "-c".into(),
                format!("approval_policy=\"{APPROVAL_POLICY}\""),
            ],
            env_set,
            env_remove: BILLING_ENV_VARS.iter().map(|s| s.to_string()).collect(),
            cwd: cfg.cwd.clone(),
        }
    }

    fn start(&mut self, cfg: &SessionConfig) -> AdapterOutput {
        self.cwd = cfg.cwd.to_string_lossy().into_owned();
        self.model = cfg.model.clone().filter(|m| !m.is_empty());
        self.system_prompt = Some(cfg.system_prompt.clone()).filter(|s| !s.trim().is_empty());
        self.use_host_config = cfg.use_host_config;
        self.mcp = Some(cfg.mcp.clone());
        self.resume_id = cfg.resume_id.clone().filter(|s| !s.is_empty());
        let params = InitializeParams {
            client_info: ClientInfo {
                name: CLIENT_NAME.into(),
                title: "Excalidraw Desktop".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: InitializeCapabilities {
                experimental_api: true,
                opt_out_notification_methods: vec!["turn/diff/updated".into()],
            },
        };
        let line = self.request(M_INITIALIZE, params, Pending::Initialize);
        AdapterOutput {
            events: vec![],
            writes: vec![line],
        }
    }

    fn prompt(&mut self, turn_id: &str, text: &str) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        if self.dead {
            out.events.push(AgentEvent::Error {
                kind: ErrorKind::Other,
                message: "The Codex session has ended; start a new conversation.".into(),
                fatal: true,
            });
            return out;
        }
        if self.turn.is_some() {
            out.events.push(AgentEvent::Error {
                kind: ErrorKind::Other,
                message: "Codex is still working on the previous message.".into(),
                fatal: false,
            });
            return out;
        }
        self.turn = Some(ActiveTurn {
            app_turn_id: turn_id.to_string(),
            queued_text: Some(text.to_string()),
            ..ActiveTurn::default()
        });
        out.events.push(AgentEvent::TurnStarted {
            turn_id: turn_id.to_string(),
        });
        self.send_turn(&mut out);
        out
    }

    fn cancel(&mut self) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        let Some(turn) = self.turn.as_mut() else {
            return out;
        };
        if turn.queued_text.is_some() {
            // Never reached Codex.
            self.end_turn(&mut out, StopReason::Cancelled);
            return out;
        }
        turn.cancel_requested = true;
        for (_, a) in self.approvals.drain() {
            let resp = match a.kind {
                ApprovalKind::Command | ApprovalKind::FileChange => json!({ "decision": "cancel" }),
                ApprovalKind::ExecV1 | ApprovalKind::PatchV1 => json!({ "decision": "abort" }),
                ApprovalKind::McpToolCall { .. } => json!({ "action": "cancel" }),
                ApprovalKind::Permissions { .. } => json!({ "permissions": {}, "scope": "turn" }),
            };
            out.writes.push(response_line(&a.rpc_id, resp));
        }
        self.send_interrupt(&mut out);
        out
    }

    fn respond_permission(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        let Some(a) = self.approvals.remove(request_id) else {
            log::debug!("codex: permission response for unknown/expired request {request_id}");
            return out;
        };
        if decision == PermissionDecision::AllowForConversation {
            self.allowances.insert(a.allowance_key.clone());
        }
        out.writes.push(response_line(
            &a.rpc_id,
            approval_response(&a.kind, decision),
        ));
        out
    }

    fn on_line(&mut self, line: &str) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        match parse_frame(line.trim()) {
            Some(Incoming::Response { id, result }) => self.on_response(&mut out, id, result),
            Some(Incoming::Request { id, method, params }) => {
                self.on_server_request(&mut out, id, &method, params)
            }
            Some(Incoming::Notification { method, params }) => {
                self.on_notification(&mut out, &method, params)
            }
            None if line.trim().is_empty() => {}
            None => log::debug!("codex: ignoring non-JSON-RPC stdout line"),
        }
        out
    }

    fn on_stderr(&mut self, line: &str) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        if let Some(kind) = errors::classify_stderr(line) {
            if !self.stderr_reported.contains(&kind) {
                self.stderr_reported.push(kind);
                out.events.push(AgentEvent::Error {
                    kind,
                    message: line.trim().to_string(),
                    fatal: false,
                });
            }
        }
        out
    }
}
