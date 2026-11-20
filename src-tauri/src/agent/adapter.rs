//! Sans-IO engine adapter contract. Adapters never touch processes or sockets: the core
//! `manager` spawns the [`LaunchSpec`], feeds every stdout line to [`EngineAdapter::on_line`],
//! and writes returned lines to stdin. This keeps adapters testable against recorded fixtures.
use super::events::{AgentEvent, EngineKind, PermissionDecision};
use std::path::{Component, Path, PathBuf};

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
    /// The conversation's session folder (`<appData>/agent/conversations/<id>`), or the
    /// attached folder when it was attached before the conversation started.
    pub cwd: PathBuf,
    pub attached_folder: Option<PathBuf>,
    /// Canonical directories the agent may write to without asking: `cwd`, plus the attached
    /// folder when that is not the cwd (attached mid-conversation). Nothing else is writable.
    pub writable_roots: Vec<PathBuf>,
    /// D-AI5 "Use my agent's MCPs, skills & plugins".
    pub use_host_config: bool,
    pub model: Option<String>,
    pub mcp: McpEndpoint,
    /// Appended to the engine's own system prompt.
    pub system_prompt: String,
    /// Engine-native session id to resume, if any.
    pub resume_id: Option<String>,
}

/// Lexically normalise `path` (relative paths resolve against `base`) and resolve symlinks in
/// the deepest existing ancestor, so `/var/…` and `/private/var/…` compare equal on macOS and a
/// symlink can't smuggle a write out of a root. `None` if `..` climbs above the filesystem root.
pub fn resolve_path(path: &Path, base: &Path) -> Option<PathBuf> {
    // `~` is expanded by some engines but not by us: never treat it as relative to `base`.
    if path.starts_with("~") {
        return None;
    }
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut lexical = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                // Resolve symlinks before popping, as the OS would (`link/..` is link's parent).
                if let Ok(canon) = lexical.canonicalize() {
                    lexical = canon;
                }
                if !lexical.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            other => lexical.push(other.as_os_str()),
        }
    }
    let mut existing = lexical.clone();
    let mut rest = Vec::new();
    loop {
        if let Ok(canon) = existing.canonicalize() {
            let mut out = canon;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return Some(out);
        }
        match (
            existing.file_name().map(|n| n.to_os_string()),
            existing.parent(),
        ) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => return Some(lexical),
        }
    }
}

/// True iff `path` (relative to `base`) resolves inside one of `roots` (already canonical).
pub fn is_within_roots(path: &Path, base: &Path, roots: &[PathBuf]) -> bool {
    match resolve_path(path, base) {
        Some(p) => roots.iter().any(|r| p.starts_with(r)),
        None => false,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_roots_resolves_relative_dotdot_and_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let roots = vec![root.canonicalize().unwrap()];
        assert!(is_within_roots(Path::new("a.txt"), &root, &roots));
        assert!(is_within_roots(Path::new("sub/new/b.md"), &root, &roots));
        assert!(is_within_roots(&root.join("sub/../c.txt"), &root, &roots));
        assert!(!is_within_roots(Path::new("../escape.txt"), &root, &roots));
        assert!(!is_within_roots(&root.join("sub/../../x"), &root, &roots));
        assert!(!is_within_roots(Path::new("/etc/passwd"), &root, &roots));
        // Sibling with a common string prefix is outside.
        assert!(!is_within_roots(&tmp.path().join("rootx/f"), &root, &roots));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(tmp.path(), root.join("link")).unwrap();
            assert!(!is_within_roots(Path::new("link/out.txt"), &root, &roots));
            // `link/..` is the symlink target's parent, not `root`.
            std::fs::create_dir_all(tmp.path().join("t/u")).unwrap();
            std::os::unix::fs::symlink(tmp.path().join("t/u"), root.join("hop")).unwrap();
            assert!(!is_within_roots(Path::new("hop/../x.txt"), &root, &roots));
        }
        assert!(!is_within_roots(Path::new("~/.zshrc"), &root, &roots));
    }
}
