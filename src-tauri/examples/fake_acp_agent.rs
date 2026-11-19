//! Scriptable fake ACP agent (NDJSON JSON-RPC over stdio) for adapter/integration/e2e tests.
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
//!
//! Run: `cargo run --manifest-path src-tauri/Cargo.toml --example fake_acp_agent`
//!
//! Each `session/prompt` streams a thought, text deltas, a plan, a completed canvas tool call
//! (`excalidraw-add_elements`, Copilot's title spelling, with `_meta` naming `mcp__excalidraw__add_elements`),
//! then asks `session/request_permission` for a non-canvas tool (`web_fetch`) and waits. After
//! the answer it reports the outcome as text and returns `end_turn` with usage. A
//! `session/cancel` while waiting answers the prompt with `cancelled`.
//!
//! Scripting (env vars):
//! - `FAKE_ACP_AUTH_FAIL=1`: `session/new` fails with -32000 "Authentication required".
//! - `FAKE_ACP_NO_PERMISSION=1`: skip the permission request.
//! - `FAKE_ACP_STOP_REASON=<reason>`: stop reason for completed turns (default `end_turn`).
//! - `FAKE_ACP_DELAY_MS=<n>`: sleep between streamed updates.
//!
//! Unknown requests get -32601. stderr carries a one-line log per message.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::time::Duration;

struct Agent {
    out: io::Stdout,
    next_id: u64,
    session_counter: u64,
    /// (prompt rpc id, permission rpc id) while a turn waits on the user.
    waiting: Option<(Value, u64)>,
    session_id: String,
    auth_fail: bool,
    ask_permission: bool,
    stop_reason: String,
    delay: Duration,
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

impl Agent {
    fn send(&mut self, v: Value) {
        let mut lock = self.out.lock();
        let _ = writeln!(lock, "{v}");
        let _ = lock.flush();
    }

    fn result(&mut self, id: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn error(&mut self, id: &Value, code: i64, message: &str) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
    }

    fn update(&mut self, update: Value) {
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        let sid = self.session_id.clone();
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": sid, "update": update},
        }));
    }

    fn text(&mut self, text: &str) {
        self.update(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}));
    }

    fn on_request(&mut self, id: Value, method: &str, params: &Value) {
        match method {
            "initialize" => self.result(
                &id,
                json!({
                    "protocolVersion": 1,
                    "agentInfo": {"name": "fake-acp-agent", "version": "0.1.0"},
                    "agentCapabilities": {"loadSession": true, "mcpCapabilities": {"http": true}},
                    "authMethods": [],
                }),
            ),
            "session/new" if self.auth_fail => self.error(&id, -32000, "Authentication required"),
            "session/new" => {
                self.session_counter += 1;
                self.session_id = format!("fake-session-{}", self.session_counter);
                let sid = self.session_id.clone();
                self.result(
                    &id,
                    json!({
                        "sessionId": sid,
                        "models": {
                            "currentModelId": "fake-model",
                            "availableModels": [{"modelId": "fake-model", "name": "Fake model"}],
                        },
                    }),
                );
            }
            "session/load" => {
                self.session_id = params["sessionId"].as_str().unwrap_or_default().to_owned();
                self.result(&id, Value::Null);
            }
            "session/set_model" | "session/set_config_option" | "session/set_mode" => {
                self.result(&id, json!({}))
            }
            "session/prompt" => self.on_prompt(id, params),
            _ => self.error(&id, -32601, &format!("method not found: {method}")),
        }
    }

    fn on_prompt(&mut self, id: Value, params: &Value) {
        if self.waiting.is_some() {
            return self.error(&id, -32600, "a prompt is already running");
        }
        let said = params["prompt"]
            .as_array()
            .and_then(|blocks| blocks.iter().rev().find_map(|b| b["text"].as_str()))
            .unwrap_or_default()
            .to_owned();
        self.update(json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Thinking about the canvas."}}));
        self.text("You said: ");
        self.text(&said);
        self.text("\n");
        self.update(json!({"sessionUpdate": "plan", "entries": [
            {"content": "Add a rectangle", "priority": "high", "status": "in_progress"},
            {"content": "Check a web page", "priority": "low", "status": "pending"},
        ]}));
        let elements = json!({"elements": [{"type": "rectangle", "x": 0, "y": 0, "width": 120, "height": 60}]});
        self.update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "fake-tool-1",
            "title": "excalidraw-add_elements", "kind": "other", "status": "pending",
            "rawInput": elements, "_meta": {"toolName": "mcp__excalidraw__add_elements"},
        }));
        self.update(json!({"sessionUpdate": "tool_call_update", "toolCallId": "fake-tool-1", "status": "in_progress"}));
        self.update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "fake-tool-1", "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": "Added 1 element"}}],
        }));
        if !self.ask_permission {
            self.text("Done.");
            return self.finish(&id, None);
        }
        let input = json!({"url": "https://example.com"});
        self.update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "fake-tool-2",
            "title": "Fetching https://example.com", "kind": "fetch", "status": "pending", "rawInput": input,
        }));
        let perm_id = self.next_id;
        self.next_id += 1;
        let sid = self.session_id.clone();
        self.send(json!({
            "jsonrpc": "2.0", "id": perm_id, "method": "session/request_permission",
            "params": {
                "sessionId": sid,
                "toolCall": {"toolCallId": "fake-tool-2", "title": "Fetching https://example.com", "kind": "fetch", "rawInput": input},
                "options": [
                    {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "allow-always", "name": "Always allow", "kind": "allow_always"},
                    {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
                ],
            },
        }));
        self.waiting = Some((id, perm_id));
    }

    fn on_permission_answer(&mut self, result: Option<&Value>) {
        let Some((prompt_id, _)) = self.waiting.take() else {
            return;
        };
        let outcome = result.map(|r| &r["outcome"]);
        let selected = outcome
            .filter(|o| o["outcome"] == "selected")
            .and_then(|o| o["optionId"].as_str())
            .unwrap_or("cancelled")
            .to_owned();
        let allowed = selected.starts_with("allow");
        self.update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "fake-tool-2",
            "status": if allowed { "completed" } else { "failed" },
            "rawOutput": if allowed { "<html>example</html>" } else { "denied" },
        }));
        self.text(&format!("Permission outcome: {selected}."));
        self.finish(&prompt_id, None);
    }

    fn finish(&mut self, id: &Value, reason: Option<&str>) {
        let reason = reason.unwrap_or(&self.stop_reason).to_owned();
        self.result(
            id,
            json!({"stopReason": reason, "usage": {"inputTokens": 42, "outputTokens": 7, "totalTokens": 49}}),
        );
    }

    fn on_line(&mut self, line: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            eprintln!("fake_acp_agent: ignoring non-JSON line");
            return;
        };
        let method = msg.get("method").and_then(Value::as_str);
        let id = msg.get("id").cloned().filter(|v| !v.is_null());
        eprintln!("fake_acp_agent: <- {}", method.unwrap_or("response"));
        match (method, id) {
            (Some(m), Some(id)) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                self.on_request(id, m, &params);
            }
            (Some("session/cancel"), None) => {
                if let Some((prompt_id, _)) = self.waiting.take() {
                    self.finish(&prompt_id, Some("cancelled"));
                }
            }
            (Some(_), None) => {}
            (None, Some(id)) => {
                if self
                    .waiting
                    .as_ref()
                    .is_some_and(|(_, p)| id.as_u64() == Some(*p))
                {
                    self.on_permission_answer(msg.get("result"));
                }
            }
            (None, None) => {}
        }
    }
}

fn main() {
    let mut agent = Agent {
        out: io::stdout(),
        next_id: 1000,
        session_counter: 0,
        waiting: None,
        session_id: String::new(),
        auth_fail: env_flag("FAKE_ACP_AUTH_FAIL"),
        ask_permission: !env_flag("FAKE_ACP_NO_PERMISSION"),
        stop_reason: std::env::var("FAKE_ACP_STOP_REASON").unwrap_or_else(|_| "end_turn".into()),
        delay: Duration::from_millis(
            std::env::var("FAKE_ACP_DELAY_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
        ),
    };
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if !line.is_empty() {
            agent.on_line(line);
        }
    }
}
