//! Agent session manager (core lane): session id ↔ tab id ↔ engine process ↔ adapter.
//!
//! Each session runs as one actor task that owns the engine process and its sans-IO
//! [`EngineAdapter`]: it writes the adapter's `start()` handshake, feeds every stdout/stderr
//! line to `on_line`/`on_stderr`, writes returned lines to stdin, and emits every event as an
//! [`AgentEventEnvelope`] through an injectable [`EventSink`] (Tauri in production, a channel in
//! tests). Adapters and the MCP endpoint provider are injected so other lanes plug in without
//! touching this file.
use super::adapter::{AdapterOutput, EngineAdapter, McpEndpoint, SessionConfig};
use super::events::{AgentEvent, AgentEventEnvelope, EngineKind, ErrorKind, PermissionDecision};
use super::process::{self, line_channel, write_line, ProcessTree};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::ChildStdin;
use tokio::sync::mpsc;

pub type EventSink = Arc<dyn Fn(AgentEventEnvelope) + Send + Sync>;
/// Returns `None` when no adapter exists for the engine (yet).
pub type AdapterFactory = Arc<dyn Fn(EngineKind) -> Option<Box<dyn EngineAdapter>> + Send + Sync>;

/// Registers a session with the canvas MCP server (MCP lane) and hands back its endpoint.
/// `file_roots` are the canonical folders the session's `add_image` may read (cwd first).
pub trait McpEndpointProvider: Send + Sync {
    fn register(&self, session_id: &str, tab_id: &str, file_roots: &[PathBuf]) -> McpEndpoint;
    fn unregister(&self, session_id: &str);
}

/// Placeholder until the MCP lane is wired: empty endpoint, logs a warning.
pub struct UnwiredMcp;

impl McpEndpointProvider for UnwiredMcp {
    fn register(&self, session_id: &str, _tab_id: &str, _file_roots: &[PathBuf]) -> McpEndpoint {
        log::warn!("agent/manager: MCP server not wired; session {session_id} has no canvas tools");
        McpEndpoint {
            url: String::new(),
            token: String::new(),
            shim_command: Vec::new(),
        }
    }
    fn unregister(&self, _session_id: &str) {}
}

/// Placeholder until adapter lanes are wired.
pub fn no_adapters() -> AdapterFactory {
    Arc::new(|_| None)
}

/// Appended to the engine's own system prompt (D-AI4: canvas-only by default).
pub const DEFAULT_SYSTEM_PROMPT: &str = "You are working inside Excalidraw Desktop. The user's \
canvas is available through the `excalidraw` MCP tools: read the scene before editing, and make \
all diagram changes through those tools. You may create and edit files inside your working \
directory (and any folder the user attached); writes elsewhere and shell commands may need the \
user's approval, and there is no network access.";

/// How long `stop` waits for a graceful exit (after cancel + stdin EOF) before terminating.
pub const STOP_GRACE: Duration = Duration::from_secs(2);
/// After an unexpected exit, how long to keep draining buffered stdout.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
const STDERR_TAIL_LINES: usize = 20;

pub struct ManagerConfig {
    /// `<appData>/agent`; scratch cwd per tab lives below it.
    pub agent_root: PathBuf,
    pub adapters: AdapterFactory,
    pub mcp: Arc<dyn McpEndpointProvider>,
    pub sink: EventSink,
    pub system_prompt: String,
    pub stop_grace: Duration,
}

/// Everything `start` needs; binary resolution happens in the command layer (`detect`).
#[derive(Debug, Clone)]
pub struct StartRequest {
    pub tab_id: String,
    pub engine: EngineKind,
    pub binary: PathBuf,
    pub attached_folder: Option<PathBuf>,
    pub use_host_config: bool,
    pub model: Option<String>,
    pub resume_id: Option<String>,
    /// App-side conversation id. Gives each conversation a stable scratch cwd, which Claude
    /// needs to find its session again on resume. Falls back to the tab id.
    pub conversation_id: Option<String>,
    /// The folder was attached after the conversation started: keep the session folder as the
    /// cwd (Claude finds sessions by cwd) and add the folder as a second writable root.
    pub keep_session_cwd: bool,
    /// Base env for the engine (discovered PATH etc.), see `detect::ShellEnv::for_binary`.
    pub spawn_env: Vec<(String, String)>,
}

enum Cmd {
    Prompt {
        turn_id: String,
        text: String,
    },
    Cancel,
    SetModel {
        model: String,
    },
    Permission {
        request_id: String,
        decision: PermissionDecision,
    },
    Stop,
}

struct Entry {
    tab_id: String,
    tx: mpsc::UnboundedSender<Cmd>,
    tree: ProcessTree,
    /// Resolves when the actor has fully finished (process reaped, Exited emitted).
    done: tokio::sync::watch::Receiver<bool>,
}

pub struct AgentManager {
    cfg: ManagerConfig,
    sessions: Mutex<HashMap<String, Entry>>,
}

fn random_id(prefix: &str) -> String {
    format!("{prefix}-{:016x}", rand::random::<u64>())
}

/// Tab ids come from the webview; keep the scratch dir name filesystem-safe.
fn sanitize_tab_id(tab_id: &str) -> String {
    let s: String = tab_id
        .chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.chars().all(|c| c == '.') {
        "tab".into()
    } else {
        s
    }
}

/// The engine's cwd and the roots it may write to. A folder attached before the conversation
/// started is the cwd (and the only root); one attached later joins the session folder.
fn session_paths(
    session_dir: PathBuf,
    folder: Option<&PathBuf>,
    keep_session_cwd: bool,
) -> (PathBuf, Vec<PathBuf>) {
    match folder {
        Some(dir) if !keep_session_cwd => (dir.clone(), vec![dir.clone()]),
        Some(dir) if *dir != session_dir => (session_dir.clone(), vec![session_dir, dir.clone()]),
        _ => (session_dir.clone(), vec![session_dir]),
    }
}

/// Where `add_image` may load files from: the writable roots (cwd first) plus the session
/// folder, which is not a writable root when a folder was attached before the first prompt.
fn image_roots(writable_roots: &[PathBuf], session_dir: PathBuf) -> Vec<PathBuf> {
    let mut roots = writable_roots.to_vec();
    if !roots.contains(&session_dir) {
        roots.push(session_dir);
    }
    roots
}

impl AgentManager {
    pub fn new(cfg: ManagerConfig) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }

    pub fn session_for_tab(&self, tab_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(_, e)| e.tab_id == tab_id)
            .map(|(id, _)| id.clone())
    }

    fn scratch_dir(&self, tab_id: &str, conversation_id: Option<&str>) -> PathBuf {
        match conversation_id {
            Some(id) => self
                .cfg
                .agent_root
                .join("conversations")
                .join(sanitize_tab_id(id)),
            None => self.cfg.agent_root.join(sanitize_tab_id(tab_id)),
        }
    }

    /// The conversation's session folder (created if missing): the engine's default cwd and
    /// where it writes files when no folder is attached.
    pub fn session_folder(
        &self,
        tab_id: &str,
        conversation_id: Option<&str>,
    ) -> Result<PathBuf, String> {
        let dir = self.scratch_dir(tab_id, conversation_id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        Ok(dir.canonicalize().unwrap_or(dir))
    }

    /// Start an engine session for a tab (one per tab: an existing one is stopped first).
    pub async fn start(self: &Arc<Self>, req: StartRequest) -> Result<String, String> {
        if let Some(old) = self.session_for_tab(&req.tab_id) {
            log::info!(
                "agent/manager: replacing session {old} on tab {}",
                req.tab_id
            );
            self.stop(&old).await?;
        }
        let mut adapter = (self.cfg.adapters)(req.engine)
            .ok_or_else(|| format!("{:?} engine support is not available yet", req.engine))?;

        let session_dir = self.session_folder(&req.tab_id, req.conversation_id.as_deref())?;
        let folder = match &req.attached_folder {
            Some(dir) if dir.is_dir() => Some(dir.canonicalize().unwrap_or_else(|_| dir.clone())),
            Some(dir) => {
                return Err(format!(
                    "attached folder {} is not a directory",
                    dir.display()
                ))
            }
            None => None,
        };
        let (cwd, writable_roots) =
            session_paths(session_dir.clone(), folder.as_ref(), req.keep_session_cwd);
        let file_roots = image_roots(&writable_roots, session_dir);

        let session_id = random_id("agent");
        let mcp = self.cfg.mcp.register(&session_id, &req.tab_id, &file_roots);
        let session_cfg = SessionConfig {
            engine: req.engine,
            tab_id: req.tab_id.clone(),
            binary: req.binary.clone(),
            cwd,
            attached_folder: folder,
            writable_roots,
            use_host_config: req.use_host_config,
            model: req.model.clone(),
            mcp,
            system_prompt: self.cfg.system_prompt.clone(),
            resume_id: req.resume_id.clone(),
        };
        let spec = adapter.launch_spec(&session_cfg);
        log::info!(
            "agent/manager: start {session_id} tab={} engine={:?} program={} args={}",
            req.tab_id,
            req.engine,
            spec.program.display(),
            spec.args.len()
        );
        let mut proc = match process::spawn(&spec, &req.spawn_env) {
            Ok(p) => p,
            Err(e) => {
                self.cfg.mcp.unregister(&session_id);
                return Err(format!("failed to start {}: {e}", spec.program.display()));
            }
        };

        let (tx, rx) = mpsc::unbounded_channel();
        let (done_tx, done_rx) = tokio::sync::watch::channel(false);
        let tree = proc.tree.clone();
        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            Entry {
                tab_id: req.tab_id.clone(),
                tx,
                tree,
                done: done_rx,
            },
        );

        let start_out = adapter.start(&session_cfg);
        let actor = Actor {
            mgr: Arc::clone(self),
            session_id: session_id.clone(),
            tab_id: req.tab_id,
            adapter,
            stdin: proc.stdin.take(),
            saw_fatal: false,
            stderr_tail: VecDeque::new(),
        };
        tokio::spawn(async move {
            actor.run(proc, rx, start_out).await;
            let _ = done_tx.send(true);
        });
        Ok(session_id)
    }

    fn send(&self, session_id: &str, cmd: Cmd) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| format!("no agent session {session_id}"))?;
        entry
            .tx
            .send(cmd)
            .map_err(|_| format!("agent session {session_id} has ended"))
    }

    /// Queue a prompt; returns the new turn id. Progress arrives as events.
    pub fn prompt(&self, session_id: &str, text: &str) -> Result<String, String> {
        let turn_id = random_id("turn");
        self.send(
            session_id,
            Cmd::Prompt {
                turn_id: turn_id.clone(),
                text: text.to_string(),
            },
        )?;
        Ok(turn_id)
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        self.send(session_id, Cmd::Cancel)
    }

    /// Switch the model of a running session; the result arrives as `ModelChanged` or `Error`.
    pub fn set_model(&self, session_id: &str, model: &str) -> Result<(), String> {
        self.send(
            session_id,
            Cmd::SetModel {
                model: model.to_string(),
            },
        )
    }

    pub fn respond_permission(
        &self,
        session_id: &str,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), String> {
        self.send(
            session_id,
            Cmd::Permission {
                request_id: request_id.to_string(),
                decision,
            },
        )
    }

    /// Cancel, close stdin, wait `stop_grace`, then terminate/kill the tree. Resolves once the
    /// process is gone and `Exited` was emitted.
    pub async fn stop(&self, session_id: &str) -> Result<(), String> {
        let mut done = {
            let sessions = self.sessions.lock().unwrap();
            let entry = sessions
                .get(session_id)
                .ok_or_else(|| format!("no agent session {session_id}"))?;
            let _ = entry.tx.send(Cmd::Stop);
            entry.done.clone()
        };
        let _ = done.wait_for(|d| *d).await;
        Ok(())
    }

    /// App exit: stop every session, hard-killing any that don't finish in time.
    pub async fn kill_all(&self, timeout: Duration) {
        let entries: Vec<(String, ProcessTree, tokio::sync::watch::Receiver<bool>)> = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .iter()
                .map(|(id, e)| {
                    let _ = e.tx.send(Cmd::Stop);
                    (id.clone(), e.tree.clone(), e.done.clone())
                })
                .collect()
        };
        if entries.is_empty() {
            return;
        }
        log::info!(
            "agent/manager: stopping {} session(s) on exit",
            entries.len()
        );
        let waits = entries.into_iter().map(|(id, tree, mut done)| async move {
            if tokio::time::timeout(timeout, done.wait_for(|d| *d))
                .await
                .is_err()
            {
                log::warn!("agent/manager: {id} did not stop in time; killing tree");
                tree.kill();
            }
        });
        futures_util::future::join_all(waits).await;
    }

    fn emit(&self, session_id: &str, tab_id: &str, event: AgentEvent) {
        (self.cfg.sink)(AgentEventEnvelope {
            session_id: session_id.to_string(),
            tab_id: tab_id.to_string(),
            event,
        });
    }

    fn finish(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
        self.cfg.mcp.unregister(session_id);
    }
}

struct Actor {
    mgr: Arc<AgentManager>,
    session_id: String,
    tab_id: String,
    adapter: Box<dyn EngineAdapter>,
    stdin: Option<ChildStdin>,
    saw_fatal: bool,
    stderr_tail: VecDeque<String>,
}

impl Actor {
    async fn apply(&mut self, out: AdapterOutput) {
        for event in out.events {
            if matches!(event, AgentEvent::Error { fatal: true, .. }) {
                self.saw_fatal = true;
            }
            self.mgr.emit(&self.session_id, &self.tab_id, event);
        }
        for line in out.writes {
            let Some(stdin) = self.stdin.as_mut() else {
                break;
            };
            if let Err(e) = write_line(stdin, &line).await {
                log::warn!("agent/manager: {} stdin write failed: {e}", self.session_id);
                self.stdin = None;
            }
        }
    }

    fn note_stderr(&mut self, line: &str) {
        if self.stderr_tail.len() == STDERR_TAIL_LINES {
            self.stderr_tail.pop_front();
        }
        self.stderr_tail.push_back(line.to_string());
    }

    async fn run(
        mut self,
        mut proc: process::EngineProcess,
        mut rx: mpsc::UnboundedReceiver<Cmd>,
        start_out: AdapterOutput,
    ) {
        let mut stdout = proc.stdout.take().map(line_channel);
        let mut stderr = proc.stderr.take().map(line_channel);
        self.apply(start_out).await;

        let requested_stop;
        let mut exit_code = None;
        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(Cmd::Prompt { turn_id, text }) => {
                        let out = self.adapter.prompt(&turn_id, &text);
                        self.apply(out).await;
                    }
                    Some(Cmd::Cancel) => {
                        let out = self.adapter.cancel();
                        self.apply(out).await;
                    }
                    Some(Cmd::SetModel { model }) => {
                        let out = self.adapter.set_model(&model);
                        self.apply(out).await;
                    }
                    Some(Cmd::Permission { request_id, decision }) => {
                        let out = self.adapter.respond_permission(&request_id, decision);
                        self.apply(out).await;
                    }
                    Some(Cmd::Stop) | None => {
                        requested_stop = true;
                        break;
                    }
                },
                line = recv(&mut stdout) => match line {
                    Some(l) => {
                        let out = self.adapter.on_line(&l);
                        self.apply(out).await;
                    }
                    None => stdout = None,
                },
                line = recv(&mut stderr) => match line {
                    Some(l) => {
                        self.note_stderr(&l);
                        let out = self.adapter.on_stderr(&l);
                        self.apply(out).await;
                    }
                    None => stderr = None,
                },
                status = proc.child.wait() => {
                    exit_code = status.ok().and_then(|s| s.code());
                    requested_stop = false;
                    break;
                }
            }
        }

        if requested_stop {
            // Graceful: let the engine cancel the turn, then EOF on stdin, then escalate.
            let out = self.adapter.cancel();
            self.apply(out).await;
            self.stdin = None;
            exit_code =
                process::shutdown(&mut proc.child, &proc.tree, self.mgr.cfg.stop_grace).await;
        } else {
            self.drain(&mut stdout, &mut stderr).await;
            // Reap grandchildren (e.g. MCP shims) left behind by the engine.
            proc.tree.kill();
            if !self.saw_fatal {
                let tail = self
                    .stderr_tail
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                let mut message = match exit_code {
                    Some(c) => format!("The agent process exited unexpectedly (code {c})."),
                    None => "The agent process was terminated unexpectedly.".to_string(),
                };
                if !tail.is_empty() {
                    message.push('\n');
                    message.push_str(&tail);
                }
                self.mgr.emit(
                    &self.session_id,
                    &self.tab_id,
                    AgentEvent::Error {
                        kind: ErrorKind::Crashed,
                        message,
                        fatal: true,
                    },
                );
            }
        }
        log::info!(
            "agent/manager: session {} exited code={exit_code:?} requested={requested_stop}",
            self.session_id
        );
        self.mgr.emit(
            &self.session_id,
            &self.tab_id,
            AgentEvent::Exited { code: exit_code },
        );
        self.mgr.finish(&self.session_id);
    }

    /// Feed output still buffered after the process exited (bounded by [`DRAIN_TIMEOUT`]).
    async fn drain(
        &mut self,
        stdout: &mut Option<mpsc::UnboundedReceiver<String>>,
        stderr: &mut Option<mpsc::UnboundedReceiver<String>>,
    ) {
        let deadline = tokio::time::Instant::now() + DRAIN_TIMEOUT;
        while stdout.is_some() || stderr.is_some() {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break,
                line = recv(stdout) => match line {
                    Some(l) => {
                        let out = self.adapter.on_line(&l);
                        self.apply(out).await;
                    }
                    None => *stdout = None,
                },
                line = recv(stderr) => match line {
                    Some(l) => {
                        self.note_stderr(&l);
                        let out = self.adapter.on_stderr(&l);
                        self.apply(out).await;
                    }
                    None => *stderr = None,
                },
            }
        }
    }
}

/// `recv` on an optional channel; pends forever once the channel is gone.
async fn recv(rx: &mut Option<mpsc::UnboundedReceiver<String>>) -> Option<String> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Exposed for the command layer: scratch dirs live under `<appData>/agent`.
pub fn agent_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("agent")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::agent::adapter::LaunchSpec;
    use crate::agent::events::{StopReason, ToolSource};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Line protocol spoken by `FAKE_ENGINE`: `init`, `prompt <turn> <text…>`,
    /// `perm <request> <decision>`, `cancel`.
    const FAKE_ENGINE: &str = r#"
echo "booting" >&2
turn=""
while IFS= read -r line; do
  set -- $line
  case "$1" in
    init) echo "ready $PWD $FAKE_MCP";;
    prompt) turn=$2; shift 2
      if [ "$1" = crash ]; then echo "boom: fatal" >&2; exit 3; fi
      echo "delta $turn $*"; echo "permreq $turn r1";;
    perm) echo "end $turn $3";;
    cancel) echo "cancelled";;
  esac
done
"#;

    struct FakeAdapter {
        script: PathBuf,
        turn: String,
    }

    impl EngineAdapter for FakeAdapter {
        fn kind(&self) -> EngineKind {
            EngineKind::Claude
        }
        fn launch_spec(&self, cfg: &SessionConfig) -> LaunchSpec {
            LaunchSpec {
                program: "/bin/sh".into(),
                args: vec![self.script.display().to_string()],
                env_set: vec![("FAKE_MCP".into(), cfg.mcp.url.clone())],
                env_remove: vec![],
                cwd: cfg.cwd.clone(),
            }
        }
        fn start(&mut self, _cfg: &SessionConfig) -> AdapterOutput {
            AdapterOutput {
                events: vec![],
                writes: vec!["init".into()],
            }
        }
        fn prompt(&mut self, turn_id: &str, text: &str) -> AdapterOutput {
            self.turn = turn_id.into();
            AdapterOutput {
                events: vec![AgentEvent::TurnStarted {
                    turn_id: turn_id.into(),
                }],
                writes: vec![format!("prompt {turn_id} {text}")],
            }
        }
        fn cancel(&mut self) -> AdapterOutput {
            AdapterOutput {
                events: vec![],
                writes: vec!["cancel".into()],
            }
        }
        fn respond_permission(&mut self, id: &str, d: PermissionDecision) -> AdapterOutput {
            AdapterOutput {
                events: vec![],
                writes: vec![format!("perm {id} {d:?}")],
            }
        }
        fn on_line(&mut self, line: &str) -> AdapterOutput {
            let mut parts = line.splitn(3, ' ');
            let ev = match (parts.next(), parts.next(), parts.next()) {
                (Some("ready"), Some(cwd), mcp) => AgentEvent::Ready {
                    engine: EngineKind::Claude,
                    version: None,
                    model: mcp.map(str::to_string),
                    engine_session_id: Some(cwd.into()),
                },
                (Some("delta"), Some(t), Some(text)) => AgentEvent::TextDelta {
                    turn_id: t.into(),
                    text: text.into(),
                },
                (Some("permreq"), Some(t), Some(id)) => AgentEvent::PermissionRequest {
                    turn_id: t.into(),
                    request_id: id.into(),
                    tool_name: "x".into(),
                    title: "x".into(),
                    detail: None,
                },
                (Some("end"), Some(t), _) => AgentEvent::TurnEnded {
                    turn_id: t.into(),
                    stop_reason: StopReason::EndTurn,
                    usage: None,
                },
                _ => AgentEvent::ToolCall {
                    turn_id: self.turn.clone(),
                    call_id: "raw".into(),
                    name: line.into(),
                    title: None,
                    source: ToolSource::Builtin,
                    status: crate::agent::events::ToolCallStatus::Completed,
                    input: None,
                    output: None,
                },
            };
            AdapterOutput {
                events: vec![ev],
                writes: vec![],
            }
        }
    }

    struct CountingMcp {
        live: AtomicUsize,
    }

    impl McpEndpointProvider for CountingMcp {
        fn register(&self, session_id: &str, tab_id: &str, _roots: &[PathBuf]) -> McpEndpoint {
            self.live.fetch_add(1, Ordering::SeqCst);
            McpEndpoint {
                url: format!("http://127.0.0.1:1/mcp/{tab_id}"),
                token: session_id.into(),
                shim_command: vec![],
            }
        }
        fn unregister(&self, _session_id: &str) {
            self.live.fetch_sub(1, Ordering::SeqCst);
        }
    }

    struct Harness {
        mgr: Arc<AgentManager>,
        events: mpsc::UnboundedReceiver<AgentEventEnvelope>,
        mcp: Arc<CountingMcp>,
        root: tempfile::TempDir,
    }

    fn harness(script: &str) -> Harness {
        let root = tempfile::tempdir().unwrap();
        let script_path = root.path().join("engine.sh");
        std::fs::write(&script_path, script).unwrap();
        let (tx, events) = mpsc::unbounded_channel();
        let mcp = Arc::new(CountingMcp {
            live: AtomicUsize::new(0),
        });
        let mgr = AgentManager::new(ManagerConfig {
            agent_root: root.path().join("agent"),
            adapters: Arc::new(move |engine| {
                (engine == EngineKind::Claude).then(|| {
                    Box::new(FakeAdapter {
                        script: script_path.clone(),
                        turn: String::new(),
                    }) as Box<dyn EngineAdapter>
                })
            }),
            mcp: mcp.clone(),
            sink: Arc::new(move |e| {
                let _ = tx.send(e);
            }),
            system_prompt: DEFAULT_SYSTEM_PROMPT.into(),
            stop_grace: Duration::from_millis(300),
        });
        Harness {
            mgr,
            events,
            mcp,
            root,
        }
    }

    fn req(tab: &str) -> StartRequest {
        StartRequest {
            tab_id: tab.into(),
            engine: EngineKind::Claude,
            binary: "/bin/sh".into(),
            attached_folder: None,
            use_host_config: false,
            model: None,
            resume_id: None,
            conversation_id: None,
            keep_session_cwd: false,
            spawn_env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        }
    }

    async fn next(h: &mut Harness) -> AgentEventEnvelope {
        tokio::time::timeout(Duration::from_secs(5), h.events.recv())
            .await
            .expect("timed out waiting for agent event")
            .expect("sink closed")
    }

    #[tokio::test]
    async fn drives_a_full_session_lifecycle() {
        let mut h = harness(FAKE_ENGINE);
        let sid = h.mgr.start(req("tab/../1")).await.unwrap();
        assert_eq!(h.mcp.live.load(Ordering::SeqCst), 1);

        let ready = next(&mut h).await;
        assert_eq!(ready.session_id, sid);
        assert_eq!(ready.tab_id, "tab/../1");
        let AgentEvent::Ready {
            engine_session_id: Some(cwd),
            model: Some(mcp_url),
            ..
        } = ready.event
        else {
            panic!("expected ready, got {:?}", ready.event);
        };
        let expected = h.root.path().join("agent").join("tab_.._1");
        assert_eq!(
            std::fs::canonicalize(cwd).unwrap(),
            std::fs::canonicalize(expected).unwrap()
        );
        assert_eq!(mcp_url, "http://127.0.0.1:1/mcp/tab/../1");

        let turn = h.mgr.prompt(&sid, "draw a box").unwrap();
        assert!(
            matches!(next(&mut h).await.event, AgentEvent::TurnStarted { turn_id } if turn_id == turn)
        );
        assert_eq!(
            next(&mut h).await.event,
            AgentEvent::TextDelta {
                turn_id: turn.clone(),
                text: "draw a box".into()
            }
        );
        let AgentEvent::PermissionRequest { request_id, .. } = next(&mut h).await.event else {
            panic!("expected permission request");
        };
        h.mgr
            .respond_permission(&sid, &request_id, PermissionDecision::AllowOnce)
            .unwrap();
        assert!(
            matches!(next(&mut h).await.event, AgentEvent::TurnEnded { turn_id, .. } if turn_id == turn)
        );

        h.mgr.stop(&sid).await.unwrap();
        // Graceful stop: cancel reaches the engine, then it exits on stdin EOF.
        let mut rest = Vec::new();
        while let Ok(Some(e)) =
            tokio::time::timeout(Duration::from_millis(200), h.events.recv()).await
        {
            rest.push(e.event);
        }
        assert!(
            matches!(rest.last(), Some(AgentEvent::Exited { code: Some(0) })),
            "{rest:?}"
        );
        assert!(!rest.iter().any(|e| matches!(e, AgentEvent::Error { .. })));
        assert_eq!(h.mcp.live.load(Ordering::SeqCst), 0);
        assert!(h.mgr.prompt(&sid, "again").is_err());
        assert!(h.mgr.session_ids().is_empty());
    }

    #[tokio::test]
    async fn reports_crash_with_stderr_tail() {
        let mut h = harness(FAKE_ENGINE);
        let sid = h.mgr.start(req("t")).await.unwrap();
        next(&mut h).await; // ready
        h.mgr.prompt(&sid, "crash").unwrap();
        next(&mut h).await; // turnStarted
        let err = next(&mut h).await.event;
        let AgentEvent::Error {
            kind: ErrorKind::Crashed,
            fatal: true,
            message,
        } = err
        else {
            panic!("expected crash, got {err:?}");
        };
        assert!(
            message.contains("code 3") && message.contains("boom: fatal"),
            "{message}"
        );
        assert_eq!(
            next(&mut h).await.event,
            AgentEvent::Exited { code: Some(3) }
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(h.mgr.session_ids().is_empty());
        assert_eq!(h.mcp.live.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn one_session_per_tab_and_kill_all_escalates() {
        // Ignores stdin EOF and SIGTERM, so stop must escalate to SIGKILL.
        let stubborn = "trap '' TERM; read l; echo ready x; while :; do sleep 1; done";
        let mut h = harness(stubborn);
        let first = h.mgr.start(req("tab")).await.unwrap();
        next(&mut h).await;
        let second = h.mgr.start(req("tab")).await.unwrap();
        assert_ne!(first, second);
        let exited = next(&mut h).await;
        assert_eq!(exited.session_id, first);
        assert!(matches!(exited.event, AgentEvent::Exited { .. }));
        assert_eq!(h.mgr.session_ids(), vec![second.clone()]);

        h.mgr.start(req("other")).await.unwrap();
        h.mgr.kill_all(Duration::from_secs(5)).await;
        assert!(h.mgr.session_ids().is_empty());
        assert_eq!(h.mcp.live.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn session_paths_pick_cwd_and_writable_roots() {
        let s = PathBuf::from("/data/agent/conversations/c1");
        let f = PathBuf::from("/work/project");
        assert_eq!(
            session_paths(s.clone(), None, false),
            (s.clone(), vec![s.clone()])
        );
        assert_eq!(
            session_paths(s.clone(), Some(&f), false),
            (f.clone(), vec![f.clone()])
        );
        assert_eq!(
            session_paths(s.clone(), Some(&f), true),
            (s.clone(), vec![s.clone(), f.clone()])
        );
    }

    #[test]
    fn image_roots_always_include_the_session_folder() {
        let s = PathBuf::from("/data/agent/conversations/c1");
        let f = PathBuf::from("/work/project");
        assert_eq!(
            image_roots(std::slice::from_ref(&f), s.clone()),
            vec![f.clone(), s.clone()]
        );
        assert_eq!(
            image_roots(&[s.clone(), f.clone()], s.clone()),
            vec![s.clone(), f.clone()]
        );
    }

    #[tokio::test]
    async fn session_folder_is_created_per_conversation() {
        let h = harness(FAKE_ENGINE);
        let dir = h.mgr.session_folder("t", Some("c/../9")).unwrap();
        assert!(dir.is_dir());
        assert!(dir.ends_with("conversations/c_.._9"));
    }

    #[tokio::test]
    async fn rejects_unknown_engine_and_bad_folder() {
        let h = harness(FAKE_ENGINE);
        let mut r = req("t");
        r.engine = EngineKind::Codex;
        assert!(h.mgr.start(r).await.unwrap_err().contains("not available"));
        let mut r = req("t");
        r.attached_folder = Some(h.root.path().join("missing"));
        assert!(h.mgr.start(r).await.is_err());
        assert_eq!(h.mcp.live.load(Ordering::SeqCst), 0);
    }
}
