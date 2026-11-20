//! GitHub Copilot CLI specifics for the ACP adapter (`copilot --acp --stdio`).
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
//! Ported from `packages/provider-acp-registry/src/server/{adapter,copilotAcp}.ts`. Flags verified
//! against https://docs.github.com/en/copilot/reference/copilot-cli-reference (ACP server,
//! programmatic reference, command reference).
use super::super::adapter::{SessionConfig, MCP_SERVER_NAME};
use serde_json::{json, Value};

/// `_meta` key for Copilot's ACP extensions.
pub const META_KEY: &str = "github.com/copilot";
/// Extension notification carrying Copilot's native session events.
pub const SESSION_EVENT_METHOD: &str = "github.com/copilot/sessionEvent";

/// Built-in tools removed from the model's tool list (SEC-6). Shell + file-write tools; `view`,
/// `glob`, `grep` stay so the agent can read an attached folder. Only names the CLI knows: an
/// unknown name makes Copilot print an "Unknown tool name" notice (`write_bash`/`write_powershell`
/// were dropped in 1.0.106; `--deny-tool=shell` still covers any shell tool).
pub const EXCLUDED_TOOLS: &[&str] = &[
    "bash",
    "powershell",
    "list_bash",
    "read_bash",
    "stop_bash",
    "list_powershell",
    "read_powershell",
    "stop_powershell",
    "edit",
    "create",
    "apply_patch",
];

/// Permission kinds denied outright. Deny beats any allow (including the user's own config).
pub const DENIED_TOOL_KINDS: &[&str] = &["shell", "write"];

/// Env vars that would silently widen permissions or change behavior behind our back.
pub const ENV_REMOVE: &[&str] = &[
    "COPILOT_ALLOW_ALL",
    "COPILOT_ASSISTED_APPROVAL",
    "COPILOT_PLAN_THEN_AUTOPILOT",
];

/// Extra env vars stripped when the user did not opt into their own config (D-AI5).
pub const ENV_REMOVE_HOST_CONFIG: &[&str] =
    &["COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "COPILOT_SKILLS_DIRS"];

/// Copilot-native events we opt into through `initialize.clientCapabilities._meta`.
pub const SUBSCRIBED_EVENTS: &[&str] = &[
    "assistant.turn_start",
    "assistant.idle",
    "tool.execution_start",
];

/// `copilot` arguments. Sandbox flags are unconditional; never emits `--allow-all*`.
pub fn launch_args(cfg: &SessionConfig) -> Vec<String> {
    let mut args = vec![
        "--acp".to_owned(),
        "--stdio".to_owned(),
        format!("--excluded-tools={}", EXCLUDED_TOOLS.join(",")),
    ];
    args.extend(DENIED_TOOL_KINDS.iter().map(|k| format!("--deny-tool={k}")));
    // Our canvas server's tools never prompt (server-scoped allow; deny rules still win).
    args.push(format!("--allow-tool={MCP_SERVER_NAME}"));
    args.push("--no-ask-user".to_owned());
    args.push("--no-auto-update".to_owned());
    if !cfg.use_host_config {
        args.push("--disable-builtin-mcps".to_owned());
        // computer-use is a separate built-in server not covered by --disable-builtin-mcps.
        args.push("--disable-mcp-server=computer-use".to_owned());
        args.push("--no-custom-instructions".to_owned());
    }
    if let Some(model) = cfg
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        args.push(format!("--model={model}"));
    }
    args
}

pub fn env_remove(cfg: &SessionConfig) -> Vec<String> {
    let mut out: Vec<String> = ENV_REMOVE.iter().map(|s| (*s).to_owned()).collect();
    if !cfg.use_host_config {
        out.extend(ENV_REMOVE_HOST_CONFIG.iter().map(|s| (*s).to_owned()));
    }
    out
}

pub fn client_capabilities_meta() -> Value {
    json!({ META_KEY: { "events": SUBSCRIBED_EVENTS } })
}

/// Copilot streams its own CLI notices ("Info: Disabled tools: …", "Warning: …") as
/// `agent_message_chunk`s without a `messageId`; they are diagnostics, not assistant text.
pub fn is_cli_notice(text: &str) -> bool {
    const PREFIXES: &[&str] = &["Info: ", "Warning: "];
    let t = text.trim_start();
    PREFIXES.iter().any(|p| t.starts_with(p))
}

/// Copilot loses its session server-side; the process must be restarted.
pub fn is_lost_session_error(code: i64, text: &str) -> bool {
    const MARKERS: &[&str] = &[
        "session event delivery failed: session not found: ",
        "session lock unavailable during is_session_generation_current: acquisition timed out",
    ];
    code == super::types::error_code::INTERNAL_ERROR && MARKERS.iter().any(|m| text.contains(m))
}

/// Parsed `github.com/copilot/sessionEvent` notification.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    TurnStart,
    /// Foreground work is done (root agent, not aborted).
    Idle,
    ToolStart {
        tool_call_id: String,
        identity: ToolIdentity,
    },
    Ignored,
}

/// Real identity of a tool call that Copilot reports with a flattened title / generic kind.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolIdentity {
    Mcp { server: String, tool: String },
    Native { tool: String },
}

pub fn parse_session_event(params: &Value) -> SessionEvent {
    let data = params.get("data").cloned().unwrap_or(Value::Null);
    let s = |k: &str| {
        data.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    match params.get("type").and_then(Value::as_str) {
        Some("assistant.turn_start") if s("agentId").is_none() => SessionEvent::TurnStart,
        Some("assistant.idle")
            if s("agentId").is_none() && data.get("aborted") != Some(&Value::Bool(true)) =>
        {
            SessionEvent::Idle
        }
        Some("tool.execution_start") => {
            let Some(tool_call_id) = s("toolCallId") else {
                return SessionEvent::Ignored;
            };
            let identity = match (s("mcpServerName"), s("mcpToolName"), s("toolName")) {
                (Some(server), Some(tool), _) => ToolIdentity::Mcp { server, tool },
                (_, _, Some(tool)) => ToolIdentity::Native { tool },
                _ => return SessionEvent::Ignored,
            };
            SessionEvent::ToolStart {
                tool_call_id,
                identity,
            }
        }
        _ => SessionEvent::Ignored,
    }
}

/// Copilot reports glob/grep/rg as `read`/`other`; they are searches.
pub fn normalized_native_kind(tool: &str) -> Option<&'static str> {
    matches!(tool, "glob" | "grep" | "rg").then_some("search")
}
