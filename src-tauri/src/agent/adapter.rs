//! Sans-IO engine adapter contract. Adapters never touch processes or sockets: the core
//! `manager` spawns the [`LaunchSpec`], feeds every stdout line to [`EngineAdapter::on_line`],
//! and writes returned lines to stdin. This keeps adapters testable against recorded fixtures.
use super::events::{AgentEvent, EngineKind, PermissionDecision};
use std::path::PathBuf;

/// How engines reach our canvas MCP server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpEndpoint {
    /// Streamable-HTTP URL, e.g. `http://127.0.0.1:53111/mcp`.
    pub url: String,
    /// Per-session bearer token.
    pub token: String,
    /// Stdio shim: `[<app binary>, "--mcp-shim"]`; env `EXCALIDRAW_MCP_URL` + `EXCALIDRAW_MCP_TOKEN`.
    pub shim_command: Vec<String>,
}

/// MCP server name engines see; canvas tools appear as e.g. `mcp__excalidraw__add_elements`.
pub const MCP_SERVER_NAME: &str = "excalidraw";
pub const MCP_SHIM_FLAG: &str = "--mcp-shim";
pub const MCP_URL_ENV: &str = "EXCALIDRAW_MCP_URL";
pub const MCP_TOKEN_ENV: &str = "EXCALIDRAW_MCP_TOKEN";

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub engine: EngineKind,
    pub tab_id: String,
    /// Resolved engine binary (from `detect`).
    pub binary: PathBuf,
    /// Scratch dir `<appData>/agent/<tabId>` or the attached (read-only) folder.
    pub cwd: PathBuf,
    pub attached_folder: Option<PathBuf>,
    /// D-AI5 "Use my agent's MCPs, skills & plugins".
    pub use_host_config: bool,
    pub model: Option<String>,
    pub mcp: McpEndpoint,
    /// Appended to the engine's own system prompt.
    pub system_prompt: String,
    /// Engine-native session id to resume, if any.
    pub resume_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env_set: Vec<(String, String)>,
    /// e.g. `ANTHROPIC_API_KEY` for Claude (SEC-6: never switch billing silently).
    pub env_remove: Vec<String>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AdapterOutput {
    pub events: Vec<AgentEvent>,
    /// NDJSON lines (without trailing newline) to write to the engine's stdin.
    pub writes: Vec<String>,
}

pub trait EngineAdapter: Send {
    fn kind(&self) -> EngineKind;
    /// Command line, with sandbox flags ALWAYS present (SEC-6; unit-tested per adapter).
    fn launch_spec(&self, cfg: &SessionConfig) -> LaunchSpec;
    /// Handshake lines to send right after spawn (e.g. ACP `initialize` + `session/new`).
    fn start(&mut self, cfg: &SessionConfig) -> AdapterOutput;
    fn prompt(&mut self, turn_id: &str, text: &str) -> AdapterOutput;
    fn cancel(&mut self) -> AdapterOutput;
    fn respond_permission(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> AdapterOutput;
    /// One line of engine stdout.
    fn on_line(&mut self, line: &str) -> AdapterOutput;
    /// Engine stderr line; adapters may map known auth/version errors to `AgentEvent::Error`.
    fn on_stderr(&mut self, _line: &str) -> AdapterOutput {
        AdapterOutput::default()
    }
    /// Switch the session's model mid-conversation. Engines that can't (Claude `-p`) report a
    /// non-fatal error; the UI only offers the switch where `engineCaps.liveModelSwitch` is set.
    fn set_model(&mut self, _model: &str) -> AdapterOutput {
        AdapterOutput {
            events: vec![AgentEvent::Error {
                kind: crate::agent::events::ErrorKind::Other,
                message: "This engine can't change models mid-conversation. Start a new conversation to use a different model.".into(),
                fatal: false,
            }],
            writes: vec![],
        }
    }
}
