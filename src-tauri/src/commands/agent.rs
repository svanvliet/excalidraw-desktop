//! Tauri commands for the AI agent (FR-27..FR-34). The core lane implements session commands;
//! the MCP lane implements `agent_tool_result`. TS wrappers live in `src/ipc/commands.ts`.
//!
//! AI toggle (SEC-3): the `ai` setting lives in the TS settings store, so the UI lane gates every
//! call behind it. These commands never run on their own: detection spawns only `--version` /
//! offline auth probes, and sessions start solely on an explicit `agent_start`.
use crate::agent::adapter::McpEndpoint;
use crate::agent::detect::{self, EngineInfo, ProbeEnv};
use crate::agent::events::{EngineKind, PermissionDecision, ToolCallResult, AGENT_EVENT};
use crate::agent::manager::{self, AgentManager, ManagerConfig, StartRequest};
use crate::agent::mcp::{McpServer, TauriToolSink};
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

pub type AgentState = Arc<AgentManager>;

/// One adapter per engine kind; the manager owns each instance for a single session.
fn adapter_factory() -> manager::AdapterFactory {
    Arc::new(
        |kind| -> Option<Box<dyn crate::agent::adapter::EngineAdapter>> {
            match kind {
                EngineKind::Claude => Some(Box::new(crate::agent::claude::ClaudeAdapter::new())),
                EngineKind::Copilot => Some(Box::new(crate::agent::acp::AcpAdapter::copilot())),
                EngineKind::Codex => Some(Box::new(crate::agent::codex::CodexAdapter::new())),
            }
        },
    )
}

/// Routes manager registrations to the app-wide loopback MCP server, which `agent_start`
/// starts lazily so nothing listens until the user actually starts an agent.
struct GlobalMcp;

impl manager::McpEndpointProvider for GlobalMcp {
    fn register(&self, session_id: &str, tab_id: &str) -> McpEndpoint {
        match McpServer::global() {
            Some(server) => server.register_session(session_id, tab_id),
            None => manager::UnwiredMcp.register(session_id, tab_id),
        }
    }
    fn unregister(&self, session_id: &str) {
        if let Some(server) = McpServer::global() {
            server.unregister_session(session_id);
        }
    }
}

/// Build the managed [`AgentManager`]. Events go to the webview as `agent://event`.
///
pub fn create_manager(app: &AppHandle) -> AgentState {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("excalidraw-desktop"));
    let handle = app.clone();
    AgentManager::new(ManagerConfig {
        agent_root: manager::agent_root(&data_dir),
        adapters: adapter_factory(),
        mcp: Arc::new(GlobalMcp),
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
    app: AppHandle,
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
    McpServer::start_global(Arc::new(TauriToolSink(app.clone())))
        .await
        .map_err(|e| AppError::Other(format!("could not start the canvas tool server: {e}")))?;
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

/// Live end-to-end smoke tests against the engines installed on this machine: the real adapter
/// factory and manager, the loopback MCP server, and a fake canvas that answers tool calls.
/// Each runs one small model turn:
/// `cargo test --lib commands::agent::live_tests -- --ignored --nocapture --test-threads=1`.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::agent::events::{AgentEvent, StopReason, ToolCallRequest, ToolCallResult};
    use crate::agent::mcp::{McpServerOptions, ToolCallSink};
    use std::sync::Mutex;
    use std::time::Duration;

    struct FakeCanvas(Mutex<Option<Arc<McpServer>>>, Mutex<Vec<String>>);

    impl ToolCallSink for FakeCanvas {
        fn emit(&self, req: &ToolCallRequest) -> Result<(), String> {
            self.1.lock().unwrap().push(req.tool.clone());
            let text = match req.tool.as_str() {
                "list_tabs" => {
                    r#"[{"tabId":"tab-1","title":"Untitled","active":true}]"#.to_string()
                }
                _ => r#"{"ok":true,"revision":"r2","ids":["el-1"]}"#.to_string(),
            };
            let server = self.0.lock().unwrap().clone().expect("server");
            server.complete_tool_call(ToolCallResult {
                call_id: req.call_id.clone(),
                is_error: false,
                content: vec![serde_json::json!({"type":"text","text":text})],
            });
            Ok(())
        }
    }

    /// Hands out HTTP endpoints only: the stdio shim needs the app binary, not the test binary.
    struct HttpOnly(Arc<McpServer>);

    impl manager::McpEndpointProvider for HttpOnly {
        fn register(&self, session_id: &str, tab_id: &str) -> McpEndpoint {
            McpEndpoint {
                shim_command: vec![],
                ..self.0.register_session(session_id, tab_id)
            }
        }
        fn unregister(&self, session_id: &str) {
            self.0.unregister_session(session_id);
        }
    }

    async fn smoke(engine: EngineKind) {
        let probe = ProbeEnv::system().await;
        let Some(binary) = detect::resolve_binary(engine, None, &probe).await else {
            eprintln!("{engine:?} not installed; skipping");
            return;
        };
        let canvas = Arc::new(FakeCanvas(Mutex::new(None), Mutex::new(vec![])));
        let server = McpServer::bind(canvas.clone(), McpServerOptions::default())
            .await
            .unwrap();
        *canvas.0.lock().unwrap() = Some(server.clone());

        let events = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
        let root = tempfile::tempdir().unwrap();
        let mgr = AgentManager::new(ManagerConfig {
            agent_root: root.path().to_path_buf(),
            adapters: adapter_factory(),
            mcp: Arc::new(HttpOnly(server.clone())),
            sink: {
                let events = events.clone();
                Arc::new(move |env| {
                    eprintln!("{:?}", env.event);
                    events.lock().unwrap().push(env.event.clone());
                    let _ = tx.send(env.event);
                })
            },
            system_prompt: manager::DEFAULT_SYSTEM_PROMPT.to_string(),
            stop_grace: manager::STOP_GRACE,
        });
        let session = mgr
            .start(StartRequest {
                tab_id: "tab-1".into(),
                engine,
                binary: binary.clone(),
                attached_folder: None,
                use_host_config: false,
                model: None,
                resume_id: None,
                spawn_env: probe.shell.for_binary(&binary),
            })
            .await
            .unwrap();
        mgr.prompt(
            &session,
            "Add one rectangle labelled Hello to the canvas using the excalidraw add_elements \
             tool, then reply with the single word done.",
        )
        .unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(180), async {
            while let Some(e) = rx.recv().await {
                match e {
                    AgentEvent::TurnEnded { stop_reason, .. } => return Some(stop_reason),
                    AgentEvent::Error { fatal: true, .. } => return None,
                    _ => {}
                }
            }
            None
        })
        .await
        .expect("turn timed out");
        mgr.stop(&session).await.unwrap();
        server.shutdown();

        assert_eq!(ended, Some(StopReason::EndTurn));
        let tools = canvas.1.lock().unwrap().clone();
        assert!(
            tools.iter().any(|t| t == "add_elements"),
            "canvas tools called: {tools:?}"
        );
        let events = events.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Ready { .. })));
        assert!(!events
            .iter()
            .any(|e| matches!(e, AgentEvent::PermissionRequest { .. })));
    }

    #[tokio::test]
    #[ignore = "runs a real model turn"]
    async fn live_claude() {
        smoke(EngineKind::Claude).await;
    }

    #[tokio::test]
    #[ignore = "runs a real model turn"]
    async fn live_codex() {
        smoke(EngineKind::Codex).await;
    }

    #[tokio::test]
    #[ignore = "runs a real model turn"]
    async fn live_copilot() {
        smoke(EngineKind::Copilot).await;
    }
}
