//! `excalidraw-desktop --mcp-shim`: stdio ⇄ loopback-HTTP MCP relay for engines that only speak
//! stdio MCP. Runs before Tauri starts; stdout is the protocol channel, diagnostics go to stderr.
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
//! (apps/server/src/mcp/AcpMcpStdioBridge.ts: verbatim JSON-RPC relay, session/protocol-version
//! header tracking, handshake ordering, error mapping.)
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::agent::adapter::{MCP_TOKEN_ENV, MCP_URL_ENV};

const INTERNAL_ERROR: i64 = -32603;

/// Entry point for `main.rs`. Returns the process exit code.
pub fn run_from_env() -> i32 {
    let (Ok(url), Ok(token)) = (std::env::var(MCP_URL_ENV), std::env::var(MCP_TOKEN_ENV)) else {
        eprintln!("--mcp-shim requires {MCP_URL_ENV} and {MCP_TOKEN_ENV}.");
        return 2;
    };
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("--mcp-shim: failed to start runtime: {e}");
            return 1;
        }
    };
    match rt.block_on(run(url, token, tokio::io::stdin(), tokio::io::stdout())) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("--mcp-shim: {e}");
            1
        }
    }
}

#[derive(Default)]
struct BridgeState {
    session_id: Option<String>,
    protocol_version: Option<String>,
}

#[derive(Clone)]
struct Bridge {
    endpoint: String,
    authorization: String,
    client: reqwest::Client,
    state: Arc<Mutex<BridgeState>>,
    out: mpsc::UnboundedSender<String>,
}

/// Relay NDJSON JSON-RPC from `input` to `endpoint` and write every server message to `output`.
/// Returns once `input` hits EOF and all in-flight requests have been answered.
pub async fn run<R, W>(endpoint: String, token: String, input: R, output: W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(std::io::Error::other)?;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut output = output;
        while let Some(line) = rx.recv().await {
            if output.write_all(line.as_bytes()).await.is_err()
                || output.write_all(b"\n").await.is_err()
                || output.flush().await.is_err()
            {
                break;
            }
        }
    });
    let bridge = Bridge {
        endpoint,
        authorization: format!("Bearer {token}"),
        client,
        state: Arc::default(),
        out: tx,
    };

    let mut lines = BufReader::new(input).lines();
    let mut running = JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
            bridge.write(&error_message(&Value::Null, -32700, "Parse error"));
            continue;
        };
        if !envelope.is_object() {
            continue;
        }
        let method = envelope.get("method").and_then(Value::as_str);
        // Order session establishment; everything after it may run concurrently.
        if matches!(method, Some("initialize" | "notifications/initialized")) {
            bridge.forward(line, envelope).await;
        } else {
            let b = bridge.clone();
            running.spawn(async move { b.forward(line, envelope).await });
        }
        while running.try_join_next().is_some() {}
    }
    while running.join_next().await.is_some() {}
    drop(bridge);
    let _ = writer.await;
    Ok(())
}

fn error_message(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

impl Bridge {
    fn write(&self, msg: &Value) {
        let _ = self.out.send(msg.to_string());
    }

    fn emit_payload(&self, payload: Value) {
        let items = match payload {
            Value::Array(items) => items,
            v => vec![v],
        };
        for entry in items {
            if let Some(v) = entry
                .get("result")
                .and_then(|r| r.get("protocolVersion"))
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
            {
                self.state.lock().unwrap().protocol_version = Some(v.to_owned());
            }
            self.write(&entry);
        }
    }

    async fn forward(&self, line: String, envelope: Value) {
        let id = envelope.get("id").cloned();
        if let Err(msg) = self.try_forward(line).await {
            eprintln!("--mcp-shim: {msg}");
            if let Some(id) = id {
                self.write(&error_message(&id, INTERNAL_ERROR, &msg));
            }
        }
    }

    async fn try_forward(&self, line: String) -> Result<(), String> {
        let mut req = self
            .client
            .post(&self.endpoint)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("authorization", &self.authorization)
            .body(line);
        {
            let st = self.state.lock().unwrap();
            if let Some(s) = &st.session_id {
                req = req.header("mcp-session-id", s);
            }
            if let Some(v) = &st.protocol_version {
                req = req.header("mcp-protocol-version", v);
            }
        }
        let mut resp = req.send().await.map_err(|e| {
            format!(
                "Excalidraw Desktop MCP endpoint is unreachable (is the app still running?): {e}"
            )
        })?;
        if let Some(s) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.state.lock().unwrap().session_id = Some(s.to_owned());
        }
        let status = resp.status();
        if !status.is_success() {
            return Err(format!(
                "Excalidraw Desktop MCP endpoint responded with HTTP {}.",
                status.as_u16()
            ));
        }
        let is_sse = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.starts_with("text/event-stream"));
        if is_sse {
            let mut sse = SseParser::default();
            while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
                for data in sse.push(&String::from_utf8_lossy(&chunk)) {
                    if let Ok(v) = serde_json::from_str::<Value>(&data) {
                        self.emit_payload(v);
                    }
                }
            }
            return Ok(());
        }
        let body = resp.bytes().await.map_err(|e| e.to_string())?;
        if body.iter().all(u8::is_ascii_whitespace) {
            return Ok(()); // 202 Accepted for notifications/responses
        }
        let payload: Value = serde_json::from_slice(&body)
            .map_err(|e| format!("Invalid JSON from MCP endpoint: {e}"))?;
        self.emit_payload(payload);
        Ok(())
    }
}

/// Minimal `text/event-stream` decoder yielding each event's joined `data:` lines.
#[derive(Default)]
struct SseParser {
    buf: String,
    data: Vec<String>,
}

impl SseParser {
    fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buf.push_str(chunk);
        let mut events = Vec::new();
        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(d) = line.strip_prefix("data:") {
                self.data.push(d.strip_prefix(' ').unwrap_or(d).to_owned());
            }
        }
        events
    }
}

#[cfg(test)]
mod unit {
    use super::SseParser;

    #[test]
    fn sse_parser_joins_data_lines_across_chunks() {
        let mut p = SseParser::default();
        assert!(p.push("event: message\ndata: {\"a\":").is_empty());
        assert_eq!(
            p.push("1}\n\n: comment\ndata:2\r\n\r\n"),
            vec!["{\"a\":1}", "2"]
        );
    }
}
