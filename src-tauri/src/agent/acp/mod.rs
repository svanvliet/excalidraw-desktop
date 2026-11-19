//! ACP adapter (generic ACP + GitHub Copilot CLI `copilot --acp --stdio`). Owned by the ACP lane.
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
//!
//! Sans-IO: translates ACP v1 JSON-RPC (NDJSON over stdio) into canonical [`AgentEvent`]s. The
//! handshake is `initialize` → `session/new` (or `session/load` when resuming) → optional model
//! selection; prompts sent before the session is ready are queued and flushed afterwards.
pub mod copilot;
pub mod types;

#[cfg(test)]
mod tests;

use super::adapter::{
    AdapterOutput, EngineAdapter, LaunchSpec, SessionConfig, MCP_SERVER_NAME, MCP_TOKEN_ENV,
    MCP_URL_ENV,
};
use super::events::{
    AgentEvent, EngineKind, ErrorKind, PermissionDecision, PlanEntry, StopReason, ToolCallStatus,
    ToolSource, Usage,
};
use copilot::{SessionEvent, ToolIdentity};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use types::{
    error_code, method, ContentBlock, Incoming, McpServer, NameValue, PermissionOption,
    PermissionOutcome, RpcError, SessionUpdate, ToolCallFields,
};

/// Longest tool output / permission detail forwarded to the webview.
const MAX_SUMMARY_CHARS: usize = 2000;

/// Which ACP agent we're talking to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpFlavor {
    /// GitHub Copilot CLI: sandbox flags, HTTP MCP, and Copilot quirks.
    Copilot,
    /// Any other ACP agent (e.g. `claude-agent-acp`, `codex-acp`), launched as
    /// `<binary> <args…>` and reported as `engine`. Gets our MCP server via the stdio shim.
    Generic {
        engine: EngineKind,
        args: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    NotStarted,
    Initializing,
    CreatingSession,
    Ready,
    Dead,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Pending {
    Initialize,
    NewSession,
    LoadSession,
    SetModel,
    Prompt { turn_id: String },
}

#[derive(Debug, Clone)]
struct ToolState {
    name: String,
    title: Option<String>,
    kind: Option<String>,
    source: ToolSource,
    status: ToolCallStatus,
    input: Option<Value>,
    output: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingPermission {
    rpc_id: Value,
    options: Vec<PermissionOption>,
    tool_name: String,
}

pub struct AcpAdapter {
    flavor: AcpFlavor,
    phase: Phase,
    next_id: u64,
    pending: HashMap<u64, Pending>,
    // Captured in `start`.
    cwd: String,
    mcp_servers: Vec<McpServer>,
    model: Option<String>,
    resume_id: Option<String>,
    /// Prepended to the first prompt (ACP has no system-prompt field; Copilot has no flag).
    system_prompt: Option<String>,
    agent_version: Option<String>,
    load_session_supported: bool,
    session_id: Option<String>,
    queued: Vec<(String, String)>,
    current_turn: Option<String>,
    // Copilot `assistant.*` tracking for the held-prompt quirk.
    copilot_turn_started: bool,
    async_shell_seen: bool,
    tools: HashMap<String, ToolState>,
    copilot_identities: HashMap<String, ToolIdentity>,
    permissions: HashMap<String, PendingPermission>,
    next_permission: u64,
    allowed_for_conversation: HashSet<String>,
    stderr_auth_reported: bool,
}

impl AcpAdapter {
    pub fn new(flavor: AcpFlavor) -> Self {
        Self {
            flavor,
            phase: Phase::NotStarted,
            next_id: 1,
            pending: HashMap::new(),
            cwd: String::new(),
            mcp_servers: Vec::new(),
            model: None,
            resume_id: None,
            system_prompt: None,
            agent_version: None,
            load_session_supported: false,
            session_id: None,
            queued: Vec::new(),
            current_turn: None,
            copilot_turn_started: false,
            async_shell_seen: false,
            tools: HashMap::new(),
            copilot_identities: HashMap::new(),
            permissions: HashMap::new(),
            next_permission: 1,
            allowed_for_conversation: HashSet::new(),
            stderr_auth_reported: false,
        }
    }

    /// GitHub Copilot CLI (`copilot --acp --stdio`).
    pub fn copilot() -> Self {
        Self::new(AcpFlavor::Copilot)
    }

    /// Any ACP agent launched as `<cfg.binary> <args…>`.
    pub fn generic(engine: EngineKind, args: Vec<String>) -> Self {
        Self::new(AcpFlavor::Generic { engine, args })
    }

    fn is_copilot(&self) -> bool {
        self.flavor == AcpFlavor::Copilot
    }

    fn request(
        &mut self,
        out: &mut AdapterOutput,
        pending: Pending,
        m: &str,
        params: impl serde::Serialize,
    ) {
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, pending);
        out.writes.push(types::request_line(id, m, params));
    }

    fn mcp_servers_for(&self, cfg: &SessionConfig) -> Vec<McpServer> {
        let http = || {
            McpServer::http(
                MCP_SERVER_NAME,
                &cfg.mcp.url,
                vec![NameValue {
                    name: "Authorization".into(),
                    value: format!("Bearer {}", cfg.mcp.token),
                }],
            )
        };
        // Copilot rejects client-provided stdio MCP servers, so it always gets HTTP.
        if self.is_copilot() || cfg.mcp.shim_command.is_empty() {
            return vec![http()];
        }
        vec![McpServer::Stdio {
            name: MCP_SERVER_NAME.into(),
            command: cfg.mcp.shim_command[0].clone(),
            args: cfg.mcp.shim_command[1..].to_vec(),
            env: vec![
                NameValue {
                    name: MCP_URL_ENV.into(),
                    value: cfg.mcp.url.clone(),
                },
                NameValue {
                    name: MCP_TOKEN_ENV.into(),
                    value: cfg.mcp.token.clone(),
                },
            ],
        }]
    }

    fn fail(&mut self, out: &mut AdapterOutput, kind: ErrorKind, message: String) {
        self.phase = Phase::Dead;
        out.events.push(AgentEvent::Error {
            kind,
            message,
            fatal: true,
        });
        for (turn_id, _) in std::mem::take(&mut self.queued) {
            if self.current_turn.as_deref() == Some(turn_id.as_str()) {
                self.current_turn = None;
            }
            out.events
                .push(turn_ended(&turn_id, StopReason::Error, None));
        }
        if let Some(turn_id) = self.current_turn.take() {
            out.events
                .push(turn_ended(&turn_id, StopReason::Error, None));
        }
    }

    fn send_prompt(&mut self, out: &mut AdapterOutput, turn_id: String, text: String) {
        let mut prompt = Vec::new();
        // A leading slash command must stay a lone text block; defer instructions to the next prompt.
        if !text.trim_start().starts_with('/') {
            if let Some(sys) = self.system_prompt.take() {
                prompt.push(ContentBlock::Text { text: sys });
            }
        }
        prompt.push(ContentBlock::Text { text });
        let params = types::PromptRequest {
            session_id: self.session_id.clone().unwrap_or_default(),
            prompt,
        };
        self.request(
            out,
            Pending::Prompt { turn_id },
            method::SESSION_PROMPT,
            params,
        );
    }

    fn end_turn(
        &mut self,
        out: &mut AdapterOutput,
        turn_id: &str,
        reason: StopReason,
        usage: Option<Usage>,
    ) {
        if self.current_turn.as_deref() == Some(turn_id) {
            self.current_turn = None;
        }
        self.tools.clear();
        self.copilot_identities.clear();
        self.copilot_turn_started = false;
        self.async_shell_seen = false;
        // Any permission still open belongs to the finished turn.
        self.permissions.clear();
        out.events.push(turn_ended(turn_id, reason, usage));
    }

    // ---- responses -------------------------------------------------------------------------

    fn on_response(
        &mut self,
        out: &mut AdapterOutput,
        id: &Value,
        result: Result<Value, RpcError>,
    ) {
        let Some(pending) = id.as_u64().and_then(|n| self.pending.remove(&n)) else {
            log::debug!("acp: response for unknown id {id}");
            return;
        };
        match pending {
            Pending::Initialize => self.on_initialize(out, result),
            Pending::NewSession => self.on_new_session(out, result),
            Pending::LoadSession => self.on_load_session(out, result),
            Pending::SetModel => {
                if let Err(e) = result {
                    out.events.push(AgentEvent::Error {
                        kind: ErrorKind::Other,
                        message: format!("Could not select model: {}", e.full_text()),
                        fatal: false,
                    });
                }
            }
            Pending::Prompt { turn_id } => self.on_prompt_response(out, turn_id, result),
        }
    }

    fn on_initialize(&mut self, out: &mut AdapterOutput, result: Result<Value, RpcError>) {
        let resp: types::InitializeResponse = match result {
            Ok(v) => serde_json::from_value(v).unwrap_or_default(),
            Err(e) => return self.handshake_error(out, "initialize", &e),
        };
        self.agent_version = resp.agent_info.and_then(|i| i.version);
        self.load_session_supported = resp.agent_capabilities.load_session;
        self.phase = Phase::CreatingSession;
        match self.resume_id.clone() {
            Some(sid) if self.load_session_supported => {
                let params = types::LoadSessionRequest {
                    session_id: sid,
                    cwd: self.cwd.clone(),
                    mcp_servers: self.mcp_servers.clone(),
                };
                self.request(out, Pending::LoadSession, method::SESSION_LOAD, params);
            }
            _ => self.send_new_session(out),
        }
    }

    fn send_new_session(&mut self, out: &mut AdapterOutput) {
        let params = types::NewSessionRequest {
            cwd: self.cwd.clone(),
            mcp_servers: self.mcp_servers.clone(),
        };
        self.request(out, Pending::NewSession, method::SESSION_NEW, params);
    }

    fn on_new_session(&mut self, out: &mut AdapterOutput, result: Result<Value, RpcError>) {
        let resp: types::NewSessionResponse = match result {
            Ok(v) => serde_json::from_value(v).unwrap_or_default(),
            Err(e) => return self.handshake_error(out, "session/new", &e),
        };
        let Some(session_id) = resp.session_id.clone().filter(|s| !s.is_empty()) else {
            return self.fail(
                out,
                ErrorKind::Protocol,
                "session/new returned no sessionId".into(),
            );
        };
        self.session_id = Some(session_id.clone());
        let model_option = resp.config_options.iter().find(|o| o.is_model_select());
        let reported = model_option
            .and_then(|o| o.current_value.as_str().map(str::to_owned))
            .or_else(|| {
                resp.models
                    .as_ref()
                    .and_then(|m| m.current_model_id.clone())
            });
        if let Some(model) = self.model.clone() {
            // Copilot's session/new reports its built-in default, not the model it runs
            // (github/copilot-cli#5363), so always write the selection for Copilot.
            let needs_write = self.is_copilot() || reported.as_deref() != Some(model.as_str());
            if needs_write {
                if let Some(opt) = model_option {
                    let params = types::SetConfigOptionRequest {
                        session_id,
                        config_id: opt.id.clone(),
                        value: model,
                    };
                    self.request(
                        out,
                        Pending::SetModel,
                        method::SESSION_SET_CONFIG_OPTION,
                        params,
                    );
                } else if resp.models.is_some() {
                    let params = types::SetModelRequest {
                        session_id,
                        model_id: model,
                    };
                    self.request(out, Pending::SetModel, method::SESSION_SET_MODEL, params);
                }
            }
        }
        self.become_ready(out, self.model.clone().or(reported));
    }

    fn on_load_session(&mut self, out: &mut AdapterOutput, result: Result<Value, RpcError>) {
        match result {
            Ok(_) => {
                self.session_id = self.resume_id.clone();
                // The resumed conversation already carries our instructions.
                self.system_prompt = None;
                self.become_ready(out, self.model.clone());
            }
            Err(e) if is_auth_error(&e) => self.handshake_error(out, "session/load", &e),
            Err(e) => {
                log::warn!(
                    "acp: session/load failed ({}); starting a new session",
                    e.full_text()
                );
                self.send_new_session(out);
            }
        }
    }

    fn become_ready(&mut self, out: &mut AdapterOutput, model: Option<String>) {
        self.phase = Phase::Ready;
        out.events.push(AgentEvent::Ready {
            engine: self.kind(),
            version: self.agent_version.clone(),
            model,
            engine_session_id: self.session_id.clone(),
        });
        for (turn_id, text) in std::mem::take(&mut self.queued) {
            self.send_prompt(out, turn_id, text);
        }
    }

    fn handshake_error(&mut self, out: &mut AdapterOutput, step: &str, e: &RpcError) {
        let kind = classify_error(e).unwrap_or(ErrorKind::Protocol);
        let message = match kind {
            ErrorKind::NotLoggedIn => format!("Not signed in ({step}): {}", e.full_text()),
            _ => format!("{step} failed: {}", e.full_text()),
        };
        self.fail(out, kind, message);
    }

    fn on_prompt_response(
        &mut self,
        out: &mut AdapterOutput,
        turn_id: String,
        result: Result<Value, RpcError>,
    ) {
        if self.current_turn.as_deref() != Some(turn_id.as_str()) {
            // Already settled (Copilot assistant.idle) or superseded.
            return;
        }
        match result {
            Ok(v) => {
                let resp: types::PromptResponse = serde_json::from_value(v).unwrap_or_default();
                let reason = map_stop_reason(resp.stop_reason.as_deref());
                let usage = resp.usage.map(|u| Usage {
                    input_tokens: u.input_tokens,
                    output_tokens: u.output_tokens,
                    premium_requests: None,
                });
                self.end_turn(out, &turn_id, reason, usage);
            }
            Err(e) if e.code == error_code::REQUEST_CANCELLED => {
                self.end_turn(out, &turn_id, StopReason::Cancelled, None);
            }
            Err(e) => {
                let text = e.full_text();
                if self.is_copilot() && copilot::is_lost_session_error(e.code, &text) {
                    // The engine lost its session: the manager must restart the process.
                    self.end_turn(out, &turn_id, StopReason::Error, None);
                    self.fail(
                        out,
                        ErrorKind::Crashed,
                        format!("Copilot lost the session: {text}"),
                    );
                    return;
                }
                let kind = classify_error(&e).unwrap_or(ErrorKind::Other);
                let fatal = kind == ErrorKind::NotLoggedIn;
                out.events.push(AgentEvent::Error {
                    kind,
                    message: text,
                    fatal,
                });
                self.end_turn(out, &turn_id, StopReason::Error, None);
                if fatal {
                    self.phase = Phase::Dead;
                }
            }
        }
    }

    // ---- notifications ---------------------------------------------------------------------

    fn on_session_update(&mut self, out: &mut AdapterOutput, params: Value) {
        let n: types::SessionNotification = match serde_json::from_value(params) {
            Ok(n) => n,
            Err(e) => {
                log::debug!("acp: undecodable session/update: {e}");
                return;
            }
        };
        if self.session_id.as_deref() != Some(n.session_id.as_str()) {
            return;
        }
        // Updates outside a turn (session/load replay, post-settle continuations) are dropped.
        let Some(turn_id) = self.current_turn.clone() else {
            return;
        };
        match n.update {
            SessionUpdate::AgentMessageChunk { content } => {
                if let Some(text) = types::content_text(&content).filter(|t| !t.is_empty()) {
                    out.events.push(AgentEvent::TextDelta {
                        turn_id,
                        text: text.to_owned(),
                    });
                }
            }
            SessionUpdate::AgentThoughtChunk { content } => {
                if let Some(text) = types::content_text(&content).filter(|t| !t.is_empty()) {
                    out.events.push(AgentEvent::ThinkingDelta {
                        turn_id,
                        text: text.to_owned(),
                    });
                }
            }
            SessionUpdate::ToolCall(f) => {
                self.tools.remove(&f.tool_call_id);
                let state = self.upsert_tool(&f);
                out.events
                    .push(tool_event(&turn_id, &f.tool_call_id, &state));
            }
            SessionUpdate::ToolCallUpdate(f) => {
                let state = self.upsert_tool(&f);
                out.events
                    .push(tool_event(&turn_id, &f.tool_call_id, &state));
            }
            SessionUpdate::Plan { entries } => out.events.push(AgentEvent::Plan {
                turn_id,
                entries: entries
                    .into_iter()
                    .map(|e| PlanEntry {
                        content: e.content,
                        status: e.status.unwrap_or_else(|| "pending".into()),
                    })
                    .collect(),
            }),
            SessionUpdate::UserMessageChunk { .. }
            | SessionUpdate::CurrentModeUpdate { .. }
            | SessionUpdate::UsageUpdate { .. }
            | SessionUpdate::Other => {}
        }
    }

    fn upsert_tool(&mut self, f: &ToolCallFields) -> ToolState {
        let identity = self.copilot_identities.get(&f.tool_call_id).cloned();
        let entry = self
            .tools
            .entry(f.tool_call_id.clone())
            .or_insert_with(|| ToolState {
                name: String::new(),
                title: None,
                kind: None,
                source: ToolSource::Builtin,
                status: ToolCallStatus::Pending,
                input: None,
                output: None,
            });
        if let Some(t) = f.title.as_ref().filter(|t| !t.is_empty()) {
            entry.title = Some(t.clone());
        }
        if let Some(k) = &f.kind {
            entry.kind = Some(k.clone());
        }
        if let Some(s) = f.status.as_deref() {
            entry.status = map_tool_status(s);
        }
        if let Some(i) = &f.raw_input {
            entry.input = Some(i.clone());
        }
        if let Some(o) = tool_output(f) {
            entry.output = Some(o);
        }
        let (name, source) = resolve_tool_name(identity.as_ref(), f.meta.as_ref(), entry);
        entry.name = name;
        entry.source = source;
        if let Some(ToolIdentity::Native { tool }) = &identity {
            if let Some(kind) = copilot::normalized_native_kind(tool) {
                entry.kind = Some(kind.into());
            }
        }
        let state = entry.clone();
        if state.kind.as_deref() == Some("execute") && is_async_shell(state.input.as_ref()) {
            self.async_shell_seen = true;
        }
        state
    }

    fn on_copilot_event(&mut self, out: &mut AdapterOutput, params: Value) {
        if params.get("sessionId").and_then(Value::as_str) != self.session_id.as_deref() {
            return;
        }
        match copilot::parse_session_event(&params) {
            SessionEvent::TurnStart => {
                if self.current_turn.is_some() {
                    self.copilot_turn_started = true;
                }
            }
            SessionEvent::Idle => {
                // Copilot holds session/prompt open while an async shell runs
                // (github/copilot-cli#5293); settle on foreground idle in that case only, so
                // the normal path still gets stopReason + usage from the prompt response.
                if self.copilot_turn_started && self.async_shell_seen {
                    if let Some(turn_id) = self.current_turn.clone() {
                        self.end_turn(out, &turn_id, StopReason::EndTurn, None);
                    }
                }
            }
            SessionEvent::ToolStart {
                tool_call_id,
                identity,
            } => {
                self.copilot_identities.insert(tool_call_id, identity);
            }
            SessionEvent::Ignored => {}
        }
    }

    // ---- agent → client requests -----------------------------------------------------------

    fn on_permission_request(&mut self, out: &mut AdapterOutput, id: Value, params: Value) {
        let req: types::RequestPermissionRequest = match serde_json::from_value(params) {
            Ok(r) => r,
            Err(e) => {
                out.writes.push(types::error_line(
                    &id,
                    error_code::INVALID_PARAMS,
                    &format!("invalid session/request_permission: {e}"),
                ));
                return;
            }
        };
        let state = self.upsert_tool(&req.tool_call);
        let auto = state.source == ToolSource::Canvas
            || self.allowed_for_conversation.contains(&state.name);
        if auto {
            out.writes.push(permission_reply(
                &id,
                pick_option(&req.options, &["allow_once", "allow_always"]),
            ));
            return;
        }
        let request_id = format!("perm-{}", self.next_permission);
        self.next_permission += 1;
        let detail = state
            .input
            .as_ref()
            .map(|v| truncate(&compact_json(v), MAX_SUMMARY_CHARS));
        out.events.push(AgentEvent::PermissionRequest {
            turn_id: self.current_turn.clone().unwrap_or_default(),
            request_id: request_id.clone(),
            tool_name: state.name.clone(),
            title: state.title.clone().unwrap_or_else(|| state.name.clone()),
            detail,
        });
        self.permissions.insert(
            request_id,
            PendingPermission {
                rpc_id: id,
                options: req.options,
                tool_name: state.name,
            },
        );
    }
}

impl EngineAdapter for AcpAdapter {
    fn kind(&self) -> EngineKind {
        match &self.flavor {
            AcpFlavor::Copilot => EngineKind::Copilot,
            AcpFlavor::Generic { engine, .. } => *engine,
        }
    }

    fn launch_spec(&self, cfg: &SessionConfig) -> LaunchSpec {
        match &self.flavor {
            AcpFlavor::Copilot => LaunchSpec {
                program: cfg.binary.clone(),
                args: copilot::launch_args(cfg),
                env_set: Vec::new(),
                env_remove: copilot::env_remove(cfg),
                cwd: cfg.cwd.clone(),
            },
            AcpFlavor::Generic { args, .. } => LaunchSpec {
                program: cfg.binary.clone(),
                args: args.clone(),
                env_set: Vec::new(),
                env_remove: Vec::new(),
                cwd: cfg.cwd.clone(),
            },
        }
    }

    fn start(&mut self, cfg: &SessionConfig) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        self.cwd = cfg.cwd.to_string_lossy().into_owned();
        self.mcp_servers = self.mcp_servers_for(cfg);
        self.model = cfg
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_owned);
        self.resume_id = cfg.resume_id.clone().filter(|s| !s.is_empty());
        self.system_prompt = Some(cfg.system_prompt.clone()).filter(|s| !s.trim().is_empty());
        self.phase = Phase::Initializing;
        let params = types::InitializeRequest {
            protocol_version: types::PROTOCOL_VERSION,
            client_capabilities: types::ClientCapabilities {
                meta: self.is_copilot().then(copilot::client_capabilities_meta),
                ..Default::default()
            },
            client_info: types::Implementation {
                name: "excalidraw-desktop".into(),
                title: Some("Excalidraw Desktop".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
            },
        };
        self.request(&mut out, Pending::Initialize, method::INITIALIZE, params);
        out
    }

    fn prompt(&mut self, turn_id: &str, text: &str) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        out.events.push(AgentEvent::TurnStarted {
            turn_id: turn_id.into(),
        });
        match self.phase {
            Phase::Dead | Phase::NotStarted => {
                out.events.push(AgentEvent::Error {
                    kind: ErrorKind::Crashed,
                    message: "The agent session is not running.".into(),
                    fatal: true,
                });
                out.events
                    .push(turn_ended(turn_id, StopReason::Error, None));
            }
            Phase::Initializing | Phase::CreatingSession => {
                self.current_turn = Some(turn_id.into());
                self.queued.push((turn_id.into(), text.into()));
            }
            Phase::Ready => {
                self.current_turn = Some(turn_id.into());
                self.copilot_turn_started = false;
                self.async_shell_seen = false;
                self.send_prompt(&mut out, turn_id.into(), text.into());
            }
        }
        out
    }

    fn cancel(&mut self) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        for (turn_id, _) in std::mem::take(&mut self.queued) {
            if self.current_turn.as_deref() == Some(turn_id.as_str()) {
                self.current_turn = None;
            }
            out.events
                .push(turn_ended(&turn_id, StopReason::Cancelled, None));
        }
        // ACP: every open permission request is answered `cancelled` alongside session/cancel.
        for (_, p) in std::mem::take(&mut self.permissions) {
            out.writes.push(permission_reply(&p.rpc_id, None));
        }
        if let (Some(sid), Some(_)) = (&self.session_id, &self.current_turn) {
            out.writes.push(types::notification_line(
                method::SESSION_CANCEL,
                types::CancelNotification {
                    session_id: sid.clone(),
                },
            ));
        }
        out
    }

    fn respond_permission(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        let Some(p) = self.permissions.remove(request_id) else {
            log::warn!("acp: respond_permission for unknown request {request_id}");
            return out;
        };
        // "For this conversation" is remembered here and answered `allow_once` on the wire, so
        // an agent never persists the grant beyond this conversation.
        let preference: &[&str] = match decision {
            PermissionDecision::AllowOnce | PermissionDecision::AllowForConversation => {
                &["allow_once", "allow_always"]
            }
            PermissionDecision::Deny => &["reject_once", "reject_always"],
        };
        if decision == PermissionDecision::AllowForConversation {
            self.allowed_for_conversation.insert(p.tool_name.clone());
        }
        out.writes.push(permission_reply(
            &p.rpc_id,
            pick_option(&p.options, preference),
        ));
        out
    }

    fn on_line(&mut self, line: &str) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        let line = line.trim();
        if line.is_empty() {
            return out;
        }
        let msg = match Incoming::parse(line) {
            Ok(m) => m,
            Err(e) => {
                log::debug!("acp: ignoring non-JSON-RPC stdout line ({e})");
                return out;
            }
        };
        match msg {
            Incoming::Response { id, result } => self.on_response(&mut out, &id, result),
            Incoming::Notification { method: m, params } => match m.as_str() {
                method::SESSION_UPDATE => self.on_session_update(&mut out, params),
                copilot::SESSION_EVENT_METHOD if self.is_copilot() => {
                    self.on_copilot_event(&mut out, params)
                }
                _ => {}
            },
            Incoming::Request {
                id,
                method: m,
                params,
            } => match m.as_str() {
                method::SESSION_REQUEST_PERMISSION => {
                    self.on_permission_request(&mut out, id, params)
                }
                // We advertise no fs/terminal capabilities; refuse anything else.
                _ => out.writes.push(types::error_line(
                    &id,
                    error_code::METHOD_NOT_FOUND,
                    &format!("method not supported by client: {m}"),
                )),
            },
        }
        out
    }

    fn on_stderr(&mut self, line: &str) -> AdapterOutput {
        let mut out = AdapterOutput::default();
        if !self.stderr_auth_reported && looks_like_auth_text(line) {
            self.stderr_auth_reported = true;
            out.events.push(AgentEvent::Error {
                kind: ErrorKind::NotLoggedIn,
                message: line.trim().to_owned(),
                fatal: false,
            });
        }
        out
    }
}

// ---- pure helpers ------------------------------------------------------------------------------

fn turn_ended(turn_id: &str, stop_reason: StopReason, usage: Option<Usage>) -> AgentEvent {
    AgentEvent::TurnEnded {
        turn_id: turn_id.into(),
        stop_reason,
        usage,
    }
}

fn tool_event(turn_id: &str, call_id: &str, s: &ToolState) -> AgentEvent {
    AgentEvent::ToolCall {
        turn_id: turn_id.into(),
        call_id: call_id.into(),
        name: s.name.clone(),
        title: s.title.clone(),
        source: s.source,
        status: s.status,
        input: s.input.clone(),
        output: s.output.clone(),
    }
}

fn permission_reply(id: &Value, option: Option<&PermissionOption>) -> String {
    let outcome = match option {
        Some(o) => PermissionOutcome::Selected {
            option_id: o.option_id.clone(),
        },
        None => PermissionOutcome::Cancelled,
    };
    types::result_line(id, types::RequestPermissionResponse { outcome })
}

/// First option whose kind matches, in preference order.
fn pick_option<'a>(
    options: &'a [PermissionOption],
    kinds: &[&str],
) -> Option<&'a PermissionOption> {
    kinds
        .iter()
        .find_map(|k| options.iter().find(|o| o.kind == *k))
}

fn map_stop_reason(reason: Option<&str>) -> StopReason {
    match reason {
        Some("cancelled") => StopReason::Cancelled,
        Some("max_tokens") | Some("max_turn_requests") => StopReason::MaxTurns,
        Some("refusal") => StopReason::Refusal,
        _ => StopReason::EndTurn,
    }
}

fn map_tool_status(s: &str) -> ToolCallStatus {
    match s {
        "in_progress" => ToolCallStatus::Running,
        "completed" => ToolCallStatus::Completed,
        "failed" => ToolCallStatus::Failed,
        _ => ToolCallStatus::Pending,
    }
}

/// Bare canvas tool name if `s` names a tool of our `excalidraw` MCP server, in any of the
/// spellings engines use: `mcp__excalidraw__X` (Claude), `excalidraw-X` (Copilot), `excalidraw/X`,
/// `excalidraw__X`, `excalidraw.X`, `excalidraw: X`.
pub fn canvas_tool_name(s: &str) -> Option<String> {
    let s = s.trim();
    let rest = s
        .strip_prefix("mcp__")
        .unwrap_or(s)
        .strip_prefix(MCP_SERVER_NAME)?;
    let rest = ["__", "-", "/", ".", ":"]
        .iter()
        .find_map(|sep| rest.strip_prefix(sep))?
        .trim_start();
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

fn canvas_qualified(tool: &str) -> String {
    format!("mcp__{MCP_SERVER_NAME}__{tool}")
}

fn mcp_qualified(server: &str, tool: &str) -> (String, ToolSource) {
    if server == MCP_SERVER_NAME {
        (canvas_qualified(tool), ToolSource::Canvas)
    } else {
        (format!("mcp__{server}__{tool}"), ToolSource::Host)
    }
}

/// Canonical tool name + source. Canvas tools are always reported as `mcp__excalidraw__<tool>`.
fn resolve_tool_name(
    identity: Option<&ToolIdentity>,
    meta: Option<&Value>,
    s: &ToolState,
) -> (String, ToolSource) {
    match identity {
        Some(ToolIdentity::Mcp { server, tool }) => return mcp_qualified(server, tool),
        Some(ToolIdentity::Native { tool }) => return (tool.clone(), ToolSource::Builtin),
        None => {}
    }
    let meta_str = |path: &[&str]| -> Option<String> {
        let mut v = meta?;
        for k in path {
            v = v.get(k)?;
        }
        v.as_str().map(str::to_owned).filter(|s| !s.is_empty())
    };
    if let (Some(server), Some(tool)) = (meta_str(&["serverId"]), meta_str(&["toolName"])) {
        return mcp_qualified(&server, &tool);
    }
    // claude-agent-acp reports the Claude tool name here.
    let named = meta_str(&["claudeCode", "toolName"]).or_else(|| meta_str(&["toolName"]));
    for candidate in named.iter().chain(s.title.iter()) {
        if let Some(tool) = canvas_tool_name(candidate) {
            return (canvas_qualified(&tool), ToolSource::Canvas);
        }
    }
    if let Some(n) = named {
        let source = if n.starts_with("mcp__") {
            ToolSource::Host
        } else {
            ToolSource::Builtin
        };
        return (n, source);
    }
    if !s.name.is_empty() {
        return (s.name.clone(), s.source);
    }
    let name = s
        .title
        .clone()
        .or_else(|| s.kind.clone())
        .unwrap_or_else(|| "tool".into());
    (name, ToolSource::Builtin)
}

fn tool_output(f: &ToolCallFields) -> Option<String> {
    if let Some(raw) = &f.raw_output {
        let text = match raw {
            Value::String(s) => s.clone(),
            Value::Null => return None,
            other => compact_json(other),
        };
        return Some(truncate(&text, MAX_SUMMARY_CHARS));
    }
    let text: Vec<&str> = f
        .content
        .iter()
        .flatten()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("content"))
        .filter_map(|c| c.get("content").and_then(types::content_text))
        .collect();
    (!text.is_empty()).then(|| truncate(&text.join("\n"), MAX_SUMMARY_CHARS))
}

fn is_async_shell(input: Option<&Value>) -> bool {
    input.is_some_and(|i| {
        i.get("mode").and_then(Value::as_str) == Some("async")
            || i.get("detach").and_then(Value::as_bool) == Some(true)
    })
}

fn compact_json(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_owned(),
    }
}

fn looks_like_auth_text(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    [
        "not logged in",
        "not authenticated",
        "authentication required",
        "authentication failed",
        "please log in",
        "please login",
        "copilot login",
        "no authentication information",
        "unauthorized",
        "sign in",
    ]
    .iter()
    .any(|m| t.contains(m))
}

fn is_auth_error(e: &RpcError) -> bool {
    e.code == error_code::AUTH_REQUIRED || looks_like_auth_text(&e.full_text())
}

fn classify_error(e: &RpcError) -> Option<ErrorKind> {
    if is_auth_error(e) {
        return Some(ErrorKind::NotLoggedIn);
    }
    let t = e.full_text().to_ascii_lowercase();
    if t.contains("quota") || t.contains("rate limit") || t.contains("premium request") {
        return Some(ErrorKind::QuotaExceeded);
    }
    if t.contains("disabled by your organization")
        || t.contains("not enabled for your organization")
        || t.contains("policy")
    {
        return Some(ErrorKind::OrgDisabled);
    }
    None
}
