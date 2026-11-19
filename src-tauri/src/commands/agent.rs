//! Tauri commands for the AI agent (FR-27..FR-34). The core lane implements session commands;
//! the MCP lane implements `agent_tool_result`. TS wrappers live in `src/ipc/commands.ts`.
//!
//! AI toggle (SEC-3): the `ai` setting lives in the TS settings store, so the UI lane gates every
//! call behind it. These commands never run on their own: detection spawns only `--version` /
//! offline auth probes, and sessions start solely on an explicit `agent_start`.
use crate::agent::detect::{self, EngineInfo, ProbeEnv};
use crate::agent::events::{EngineKind, PermissionDecision, ToolCallResult, AGENT_EVENT};
use crate::agent::manager::{self, AgentManager, ManagerConfig, StartRequest};
use crate::error::AppError;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOverride {
    pub engine: EngineKind,
    pub path: Option<String>,
}

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

pub type AgentState = Arc<AgentManager>;

/// Build the managed [`AgentManager`]. Events go to the webview as `agent://event`.
///
/// Integration: replace [`manager::no_adapters`] / [`manager::UnwiredMcp`] with the real
/// adapter factory (acp/claude/codex lanes) and MCP server (mcp lane).
pub fn create_manager(app: &AppHandle) -> AgentState {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("excalidraw-desktop"));
    let handle = app.clone();
    AgentManager::new(ManagerConfig {
        agent_root: manager::agent_root(&data_dir),
        adapters: manager::no_adapters(),
        mcp: Arc::new(manager::UnwiredMcp),
        sink: Arc::new(move |envelope| {
            if let Err(e) = handle.emit(AGENT_EVENT, &envelope) {
                log::warn!("agent: emit {AGENT_EVENT} failed: {e}");
            }
        }),
        system_prompt: manager::DEFAULT_SYSTEM_PROMPT.to_string(),
        stop_grace: manager::STOP_GRACE,
    })
}

fn non_empty_path(p: Option<String>) -> Option<PathBuf> {
    p.map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Probe every engine (or the overrides given). Never spawns a model turn.
#[tauri::command]
pub async fn agent_detect(overrides: Vec<EngineOverride>) -> Result<Vec<EngineInfo>, AppError> {
    let overrides: Vec<(EngineKind, Option<PathBuf>)> = overrides
        .into_iter()
        .map(|o| (o.engine, non_empty_path(o.path)))
        .collect();
    let probe = ProbeEnv::system().await;
    let infos = detect::detect_all(&overrides, &probe).await;
    for i in &infos {
        log::info!(
            "agent: detect {:?} status={:?} version={:?} path={:?}",
            i.engine,
            i.status,
            i.version,
            i.path
        );
    }
    Ok(infos)
}

/// Start an engine session bound to a tab. Returns the app session id.
#[tauri::command]
pub async fn agent_start(
    state: State<'_, AgentState>,
    options: AgentStartOptions,
) -> Result<String, AppError> {
    let probe = ProbeEnv::system().await;
    let path_override = non_empty_path(options.path_override);
    let binary = detect::resolve_binary(options.engine, path_override.as_deref(), &probe)
        .await
        .ok_or_else(|| {
            AppError::Other(match &path_override {
                Some(p) => format!("{} is not an executable file", p.display()),
                None => format!(
                    "`{}` was not found. Install it or set its path in Settings.",
                    detect::binary_name(options.engine)
                ),
            })
        })?;
    let spawn_env = probe.shell.for_binary(&binary);
    state
        .inner()
        .start(StartRequest {
            tab_id: options.tab_id,
            engine: options.engine,
            binary,
            attached_folder: non_empty_path(options.attached_folder),
            use_host_config: options.use_host_config,
            model: options.model.filter(|m| !m.trim().is_empty()),
            resume_id: options.resume_id.filter(|r| !r.trim().is_empty()),
            spawn_env,
        })
        .await
        .map_err(AppError::Other)
}

/// Send a user prompt. Returns the new turn id; progress arrives as `agent://event`.
#[tauri::command]
pub async fn agent_prompt(
    state: State<'_, AgentState>,
    session_id: String,
    text: String,
) -> Result<String, AppError> {
    state.prompt(&session_id, &text).map_err(AppError::Other)
}

#[tauri::command]
pub async fn agent_cancel(
    state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), AppError> {
    state.cancel(&session_id).map_err(AppError::Other)
}

#[tauri::command]
pub async fn agent_permission_respond(
    state: State<'_, AgentState>,
    session_id: String,
    request_id: String,
    decision: PermissionDecision,
) -> Result<(), AppError> {
    state
        .respond_permission(&session_id, &request_id, decision)
        .map_err(AppError::Other)
}

/// Stop the session and kill the engine process tree.
#[tauri::command]
pub async fn agent_stop(state: State<'_, AgentState>, session_id: String) -> Result<(), AppError> {
    state.stop(&session_id).await.map_err(AppError::Other)
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
