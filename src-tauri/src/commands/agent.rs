//! Tauri commands for the AI agent (FR-27..FR-34). Contract stubs: the core lane implements
//! session commands; the MCP lane implements `agent_tool_result`. TS wrappers live in
//! `src/ipc/commands.ts`.
use crate::agent::detect::EngineInfo;
use crate::agent::events::{EngineKind, PermissionDecision, ToolCallResult};
use crate::error::AppError;
use serde::Deserialize;

// Contract stub: fields are read once the core lane implements the commands.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOverride {
    pub engine: EngineKind,
    pub path: Option<String>,
}

// Contract stub: fields are read once the core lane implements the commands.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartOptions {
    pub tab_id: String,
    pub engine: EngineKind,
    pub path_override: Option<String>,
    pub use_host_config: bool,
    pub model: Option<String>,
    pub attached_folder: Option<String>,
    pub resume_id: Option<String>,
}

fn todo(cmd: &str) -> AppError {
    AppError::Other(format!("{cmd} is not implemented yet"))
}

/// Probe every engine (or the overrides given). Never spawns a model turn.
#[tauri::command]
pub async fn agent_detect(overrides: Vec<EngineOverride>) -> Result<Vec<EngineInfo>, AppError> {
    let _ = overrides;
    Err(todo("agent_detect"))
}

/// Start an engine session bound to a tab. Returns the app session id.
#[tauri::command]
pub async fn agent_start(options: AgentStartOptions) -> Result<String, AppError> {
    let _ = options;
    Err(todo("agent_start"))
}

/// Send a user prompt. Returns the new turn id; progress arrives as `agent://event`.
#[tauri::command]
pub async fn agent_prompt(session_id: String, text: String) -> Result<String, AppError> {
    let _ = (session_id, text);
    Err(todo("agent_prompt"))
}

#[tauri::command]
pub async fn agent_cancel(session_id: String) -> Result<(), AppError> {
    let _ = session_id;
    Err(todo("agent_cancel"))
}

#[tauri::command]
pub async fn agent_permission_respond(
    session_id: String,
    request_id: String,
    decision: PermissionDecision,
) -> Result<(), AppError> {
    let _ = (session_id, request_id, decision);
    Err(todo("agent_permission_respond"))
}

/// Stop the session and kill the engine process tree.
#[tauri::command]
pub async fn agent_stop(session_id: String) -> Result<(), AppError> {
    let _ = session_id;
    Err(todo("agent_stop"))
}

/// Webview executor → MCP server: result of an `agent://tool-call`.
#[tauri::command]
pub async fn agent_tool_result(result: ToolCallResult) -> Result<(), AppError> {
    let server = crate::agent::mcp::McpServer::global()
        .ok_or_else(|| AppError::Other("agent MCP server is not running".into()))?;
    let call_id = result.call_id.clone();
    if !server.complete_tool_call(result) {
        // Late result after a timeout/cancel: the engine already got an error; drop it.
        log::warn!("agent_tool_result: no pending tool call {call_id}");
    }
    Ok(())
}
