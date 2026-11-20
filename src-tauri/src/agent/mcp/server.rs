//! Loopback MCP server (streamable HTTP, JSON responses) for the canvas tools.
//!
//! - Binds `127.0.0.1:0`; POST `/mcp` only (GET/DELETE → 405: no server stream, no MCP sessions).
//! - Every request needs `Authorization: Bearer <token>`; a token maps to one agent session/tab.
//! - Non-loopback `Host`/`Origin` headers are rejected (DNS-rebinding guard).
//! - `tools/call` for a canvas tool is emitted to the webview through a [`ToolCallSink`] and
//!   answered by [`McpServer::complete_tool_call`] (the `agent_tool_result` command).
use std::collections::HashMap;
use std::future::Future;
use std::net::Ipv4Addr;
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use rand::RngCore;
use serde_json::{json, Value};
use tokio::sync::{oneshot, OnceCell};

use super::protocol::{self, APPROVE_TOOL};
use crate::agent::adapter::{McpEndpoint, MCP_SHIM_FLAG};
use crate::agent::events::{PermissionDecision, ToolCallRequest, ToolCallResult};

/// Default time the webview gets to answer a tool call.
pub const DEFAULT_TOOL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Delivers [`ToolCallRequest`]s to the canvas executor (the webview in the app).
pub trait ToolCallSink: Send + Sync + 'static {
    fn emit(&self, req: &ToolCallRequest) -> Result<(), String>;
}

/// Claude Code `--permission-prompt-tool` call, routed to an in-app approval card.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRequest {
    pub session_id: String,
    pub tab_id: String,
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: Option<String>,
}

pub type ApprovalFuture = Pin<Box<dyn Future<Output = PermissionDecision> + Send>>;

/// Installed by the core lane; without one, every approval is denied.
pub trait ApprovalHandler: Send + Sync + 'static {
    fn request(&self, req: ApprovalRequest) -> ApprovalFuture;
}

/// Emits tool calls to the webview as `agent://tool-call`.
pub struct TauriToolSink<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> ToolCallSink for TauriToolSink<R> {
    fn emit(&self, req: &ToolCallRequest) -> Result<(), String> {
        use tauri::Emitter;
        self.0
            .emit(crate::agent::events::AGENT_TOOL_CALL_EVENT, req)
            .map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct McpServerOptions {
    pub tool_timeout: Duration,
}

impl Default for McpServerOptions {
    fn default() -> Self {
        Self {
            tool_timeout: DEFAULT_TOOL_TIMEOUT,
        }
    }
}

struct SessionEntry {
    tab_id: String,
    token: String,
}

struct Pending {
    session_id: String,
    rpc_id: Value,
    tx: oneshot::Sender<ToolCallResult>,
}

struct ServerState {
    port: u16,
    sink: Arc<dyn ToolCallSink>,
    approval: RwLock<Option<Arc<dyn ApprovalHandler>>>,
    sessions: Mutex<HashMap<String, SessionEntry>>,
    pending: Mutex<HashMap<String, Pending>>,
    tool_timeout: Duration,
}

pub struct McpServer {
    state: Arc<ServerState>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

static GLOBAL: OnceCell<Arc<McpServer>> = OnceCell::const_new();

impl McpServer {
    /// Bind `127.0.0.1:0` and serve. Must run inside a tokio runtime.
    pub async fn bind(
        sink: Arc<dyn ToolCallSink>,
        opts: McpServerOptions,
    ) -> std::io::Result<Arc<Self>> {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let state = Arc::new(ServerState {
            port,
            sink,
            approval: RwLock::new(None),
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            tool_timeout: opts.tool_timeout,
        });
        let app = Router::new()
            .route("/mcp", any(mcp_handler))
            .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
            .with_state(state.clone());
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let server = axum::serve(listener, app).with_graceful_shutdown(async {
                let _ = rx.await;
            });
            if let Err(e) = server.await {
                log::error!("mcp: server error: {e}");
            }
        });
        log::info!("mcp: listening on 127.0.0.1:{port}");
        Ok(Arc::new(Self {
            state,
            shutdown: Mutex::new(Some(tx)),
        }))
    }

    /// Start the app-wide server on first use (lazy; idempotent — later sinks are ignored).
    pub async fn start_global(sink: Arc<dyn ToolCallSink>) -> std::io::Result<Arc<Self>> {
        GLOBAL
            .get_or_try_init(|| Self::bind(sink, McpServerOptions::default()))
            .await
            .cloned()
    }

    /// The app-wide server, if [`Self::start_global`] has run.
    pub fn global() -> Option<Arc<Self>> {
        GLOBAL.get().cloned()
    }

    pub fn port(&self) -> u16 {
        self.state.port
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.state.port)
    }

    pub fn set_approval_handler(&self, handler: Option<Arc<dyn ApprovalHandler>>) {
        *self.state.approval.write().unwrap() = handler;
    }

    /// Issue a fresh token for `session_id` (replacing any previous one).
    pub fn register_session(&self, session_id: &str, tab_id: &str) -> McpEndpoint {
        let token = new_token();
        self.state.sessions.lock().unwrap().insert(
            session_id.to_owned(),
            SessionEntry {
                tab_id: tab_id.to_owned(),
                token: token.clone(),
            },
        );
        McpEndpoint {
            url: self.url(),
            token,
            shim_command: shim_command(),
        }
    }

    /// Revoke the session's token and fail its in-flight tool calls.
    pub fn unregister_session(&self, session_id: &str) {
        self.state.sessions.lock().unwrap().remove(session_id);
        // Dropping the senders wakes the waiting handlers with "session ended".
        self.state
            .pending
            .lock()
            .unwrap()
            .retain(|_, p| p.session_id != session_id);
    }

    /// Deliver the webview's result. `false` if the call is unknown (timed out / cancelled).
    pub fn complete_tool_call(&self, result: ToolCallResult) -> bool {
        let pending = self.state.pending.lock().unwrap().remove(&result.call_id);
        match pending {
            Some(p) => p.tx.send(result).is_ok(),
            None => false,
        }
    }

    pub fn shutdown(&self) {
        if let Some(tx) = self.shutdown.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// `[<this executable>, "--mcp-shim"]`.
pub fn shim_command() -> Vec<String> {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "excalidraw-desktop".into());
    vec![exe, MCP_SHIM_FLAG.to_owned()]
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn new_call_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn is_loopback_host(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    let name = if let Some(rest) = h.strip_prefix('[') {
        // [::1]:port
        match rest.split_once(']') {
            Some((inner, _)) => inner.to_owned(),
            None => return false,
        }
    } else {
        h.rsplit_once(':')
            .map(|(n, p)| {
                if p.chars().all(|c| c.is_ascii_digit()) {
                    n
                } else {
                    h.as_str()
                }
            })
            .unwrap_or(&h)
            .to_owned()
    };
    matches!(name.as_str(), "127.0.0.1" | "localhost" | "::1")
}

fn is_loopback_origin(origin: &str) -> bool {
    let rest = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"));
    match rest {
        Some(r) => is_loopback_host(r.trim_end_matches('/')),
        None => false,
    }
}

fn status(code: StatusCode) -> Response {
    code.into_response()
}

#[derive(Clone)]
struct Caller {
    session_id: String,
    tab_id: String,
}

impl ServerState {
    fn authenticate(&self, headers: &HeaderMap) -> Option<Caller> {
        let presented = headers
            .get(header::AUTHORIZATION)?
            .to_str()
            .ok()?
            .strip_prefix("Bearer ")?
            .trim();
        let sessions = self.sessions.lock().unwrap();
        let mut found = None;
        // Compare against every token so timing doesn't reveal which (if any) matched.
        for (sid, s) in sessions.iter() {
            if ct_eq(presented.as_bytes(), s.token.as_bytes()) {
                found = Some(Caller {
                    session_id: sid.clone(),
                    tab_id: s.tab_id.clone(),
                });
            }
        }
        found
    }

    fn session_alive(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session_id)
    }
}

async fn mcp_handler(
    State(state): State<Arc<ServerState>>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(host) = headers.get(header::HOST) {
        if !host.to_str().map(is_loopback_host).unwrap_or(false) {
            return status(StatusCode::FORBIDDEN);
        }
    }
    if let Some(origin) = headers.get(header::ORIGIN) {
        if !origin.to_str().map(is_loopback_origin).unwrap_or(false) {
            return status(StatusCode::FORBIDDEN);
        }
    }
    let Some(caller) = state.authenticate(&headers) else {
        let mut r = status(StatusCode::UNAUTHORIZED);
        r.headers_mut()
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return r;
    };
    if method != Method::POST {
        // No standalone SSE stream (GET) and no MCP sessions to terminate (DELETE).
        let mut r = status(StatusCode::METHOD_NOT_ALLOWED);
        r.headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("POST"));
        return r;
    }
    if let Some(v) = headers.get("mcp-protocol-version") {
        if !v
            .to_str()
            .map(protocol::is_supported_version)
            .unwrap_or(false)
        {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(protocol::err(
                    &Value::Null,
                    protocol::INVALID_REQUEST,
                    "Unsupported MCP-Protocol-Version",
                )),
            )
                .into_response();
        }
    }
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(protocol::err(
                    &Value::Null,
                    protocol::PARSE_ERROR,
                    format!("Parse error: {e}"),
                )),
            )
                .into_response()
        }
    };
    let reply = match parsed {
        Value::Array(batch) => {
            let mut out = Vec::new();
            for msg in batch {
                if let Some(r) = handle_message(&state, &caller, msg).await {
                    out.push(r);
                }
            }
            (!out.is_empty()).then_some(Value::Array(out))
        }
        msg => handle_message(&state, &caller, msg).await,
    };
    match reply {
        Some(v) => axum::Json(v).into_response(),
        None => status(StatusCode::ACCEPTED),
    }
}

/// One JSON-RPC message → optional response (only requests get one).
async fn handle_message(state: &Arc<ServerState>, caller: &Caller, msg: Value) -> Option<Value> {
    let Value::Object(obj) = &msg else {
        return Some(protocol::err(
            &Value::Null,
            protocol::INVALID_REQUEST,
            "Invalid Request",
        ));
    };
    let method = obj.get("method").and_then(Value::as_str);
    let id = obj.get("id").cloned();
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    match (method, id) {
        // Response to a server request (we send none) — accept and ignore.
        (None, Some(_)) if obj.contains_key("result") || obj.contains_key("error") => None,
        (None, id) => Some(protocol::err(
            &id.unwrap_or(Value::Null),
            protocol::INVALID_REQUEST,
            "Invalid Request",
        )),
        (Some(m), None) => {
            if m == "notifications/cancelled" {
                if let Some(rid) = params.get("requestId") {
                    state
                        .pending
                        .lock()
                        .unwrap()
                        .retain(|_, p| !(p.session_id == caller.session_id && &p.rpc_id == rid));
                }
            }
            None
        }
        (Some(m), Some(id)) => Some(match m {
            "initialize" => protocol::ok(
                &id,
                protocol::initialize_result(params.get("protocolVersion").and_then(Value::as_str)),
            ),
            "ping" => protocol::ok(&id, json!({})),
            "tools/list" => protocol::ok(&id, json!({ "tools": protocol::catalog().tools })),
            "tools/call" => call_tool(state, caller, &id, &params).await,
            _ => protocol::err(
                &id,
                protocol::METHOD_NOT_FOUND,
                format!("Method not found: {m}"),
            ),
        }),
    }
}

/// Removes a pending entry if the HTTP request is dropped (client disconnect) before completion.
struct PendingGuard<'a> {
    state: &'a ServerState,
    call_id: String,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.state.pending.lock().unwrap().remove(&self.call_id);
    }
}

async fn call_tool(state: &Arc<ServerState>, caller: &Caller, id: &Value, params: &Value) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return protocol::err(id, protocol::INVALID_PARAMS, "Missing tool name");
    };
    let args = match params.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(v @ Value::Object(_)) => v.clone(),
        Some(_) => {
            return protocol::err(id, protocol::INVALID_PARAMS, "arguments must be an object")
        }
    };
    if name == APPROVE_TOOL {
        return protocol::ok(id, approve(state, caller, args).await);
    }
    if !protocol::catalog().canvas.contains(name) {
        return protocol::err(
            id,
            protocol::INVALID_PARAMS,
            format!("Unknown tool: {name}"),
        );
    }
    let tab_id = args
        .get("tabId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| caller.tab_id.clone());
    let call_id = new_call_id();
    let (tx, rx) = oneshot::channel();
    {
        // Re-check under the lock order sessions→pending so unregister can't race past us.
        let sessions = state.sessions.lock().unwrap();
        if !sessions.contains_key(&caller.session_id) {
            return protocol::ok(id, protocol::text_result("Agent session has ended.", true));
        }
        state.pending.lock().unwrap().insert(
            call_id.clone(),
            Pending {
                session_id: caller.session_id.clone(),
                rpc_id: id.clone(),
                tx,
            },
        );
    }
    let _guard = PendingGuard {
        state,
        call_id: call_id.clone(),
    };
    let req = ToolCallRequest {
        call_id: call_id.clone(),
        session_id: caller.session_id.clone(),
        tab_id,
        tool: name.to_owned(),
        args,
    };
    if let Err(e) = state.sink.emit(&req) {
        log::warn!("mcp: failed to deliver tool call {name}: {e}");
        return protocol::ok(
            id,
            protocol::text_result(format!("Canvas is unavailable: {e}"), true),
        );
    }
    let result = match tokio::time::timeout(state.tool_timeout, rx).await {
        Ok(Ok(r)) => json!({ "content": r.content, "isError": r.is_error }),
        Ok(Err(_)) => protocol::text_result("Agent session ended before the tool completed.", true),
        Err(_) => {
            log::warn!("mcp: tool {name} ({call_id}) timed out");
            protocol::text_result(
                format!(
                    "Timed out after {}s waiting for the canvas to run {name}.",
                    state.tool_timeout.as_secs()
                ),
                true,
            )
        }
    };
    protocol::ok(id, result)
}

/// Claude Code permission-prompt-tool contract: text content holding
/// `{"behavior":"allow","updatedInput":{..}}` or `{"behavior":"deny","message":".."}`.
async fn approve(state: &Arc<ServerState>, caller: &Caller, args: Value) -> Value {
    let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
    let handler = state.approval.read().unwrap().clone();
    let decision = match handler {
        Some(h) if state.session_alive(&caller.session_id) => {
            h.request(ApprovalRequest {
                session_id: caller.session_id.clone(),
                tab_id: caller.tab_id.clone(),
                tool_name: args
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                input: input.clone(),
                tool_use_id: args
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
            .await
        }
        _ => PermissionDecision::Deny,
    };
    let body = match decision {
        PermissionDecision::AllowOnce
        | PermissionDecision::AllowForConversation
        | PermissionDecision::AllowAll => {
            json!({ "behavior": "allow", "updatedInput": input })
        }
        PermissionDecision::Deny => {
            json!({ "behavior": "deny", "message": "The user denied this action." })
        }
    };
    protocol::text_result(body.to_string(), false)
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn loopback_host_and_origin_checks() {
        for ok in [
            "127.0.0.1:5000",
            "localhost",
            "LOCALHOST:1",
            "[::1]:80",
            "127.0.0.1",
        ] {
            assert!(is_loopback_host(ok), "{ok}");
        }
        for bad in [
            "evil.com",
            "127.0.0.1.evil.com:80",
            "localhost.evil:1",
            "[::2]:1",
        ] {
            assert!(!is_loopback_host(bad), "{bad}");
        }
        assert!(is_loopback_origin("http://localhost:1420"));
        assert!(!is_loopback_origin("https://evil.com"));
        assert!(!is_loopback_origin("null"));
        assert!(!is_loopback_origin("tauri://localhost"));
    }

    #[test]
    fn tokens_are_32_random_bytes() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(ct_eq(a.as_bytes(), a.as_bytes()));
        assert!(!ct_eq(a.as_bytes(), b.as_bytes()));
        assert!(!ct_eq(b"ab", b"abc"));
    }
}
