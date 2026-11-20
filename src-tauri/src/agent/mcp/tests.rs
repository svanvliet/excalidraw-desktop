//! Integration tests: real sockets against an in-process [`McpServer`] with a fake sink.
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use super::protocol;
use super::server::*;
use crate::agent::events::{PermissionDecision, ToolCallRequest, ToolCallResult};

struct ChanSink(mpsc::UnboundedSender<ToolCallRequest>);

impl ToolCallSink for ChanSink {
    fn emit(&self, req: &ToolCallRequest) -> Result<(), String> {
        self.0.send(req.clone()).map_err(|e| e.to_string())
    }
}

async fn server(timeout: Duration) -> (Arc<McpServer>, mpsc::UnboundedReceiver<ToolCallRequest>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let s = McpServer::bind(
        Arc::new(ChanSink(tx)),
        McpServerOptions {
            tool_timeout: timeout,
        },
    )
    .await
    .unwrap();
    (s, rx)
}

/// Answers every tool call with a text echo of `{tool, sessionId, tabId, args}`.
fn auto_respond(server: Arc<McpServer>, mut rx: mpsc::UnboundedReceiver<ToolCallRequest>) {
    tokio::spawn(async move {
        while let Some(req) = rx.recv().await {
            let text = json!({
                "tool": req.tool, "sessionId": req.session_id, "tabId": req.tab_id, "args": req.args
            });
            server.complete_tool_call(ToolCallResult {
                call_id: req.call_id,
                is_error: false,
                content: vec![json!({ "type": "text", "text": text.to_string() })],
            });
        }
    });
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

async fn post_raw(
    url: &str,
    token: Option<&str>,
    extra: &[(&str, &str)],
    body: &Value,
) -> (u16, String) {
    let mut req = client()
        .post(url)
        .header("content-type", "application/json")
        .body(body.to_string());
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.unwrap();
    let status = resp.status().as_u16();
    (status, resp.text().await.unwrap())
}

async fn rpc(url: &str, token: &str, method: &str, params: Value) -> Value {
    let (status, body) = post_raw(
        url,
        Some(token),
        &[],
        &json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str(&body).unwrap()
}

fn result_json(resp: &Value) -> Value {
    serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn rejects_missing_or_wrong_token() {
    let (s, _rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    let ep = s.register_session("s1", "tab1");
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} });
    assert_eq!(post_raw(&ep.url, None, &[], &init).await.0, 401);
    assert_eq!(post_raw(&ep.url, Some("nope"), &[], &init).await.0, 401);
    let (st, body) = post_raw(&ep.url, Some(&ep.token), &[], &init).await;
    assert_eq!(st, 200);
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["result"]["protocolVersion"],
        protocol::LATEST_PROTOCOL_VERSION
    );
    assert_eq!(v["result"]["serverInfo"]["name"], "excalidraw");
    assert!(ep.shim_command[1] == "--mcp-shim");
}

#[tokio::test]
async fn rejects_non_loopback_host_and_origin() {
    let (s, _rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    let ep = s.register_session("s1", "tab1");
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    let t = Some(ep.token.as_str());
    assert_eq!(
        post_raw(&ep.url, t, &[("host", "evil.com")], &ping).await.0,
        403
    );
    assert_eq!(
        post_raw(&ep.url, t, &[("origin", "https://evil.com")], &ping)
            .await
            .0,
        403
    );
    assert_eq!(
        post_raw(&ep.url, t, &[("origin", "null")], &ping).await.0,
        403
    );
    let local = format!("http://localhost:{}", s.port());
    assert_eq!(
        post_raw(&ep.url, t, &[("origin", &local)], &ping).await.0,
        200
    );
}

#[tokio::test]
async fn negotiates_versions_and_handles_transport_edges() {
    let (s, _rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    let ep = s.register_session("s1", "tab1");
    let v = rpc(
        &ep.url,
        &ep.token,
        "initialize",
        json!({ "protocolVersion": "2024-11-05" }),
    )
    .await;
    assert_eq!(v["result"]["protocolVersion"], "2024-11-05");
    let t = Some(ep.token.as_str());
    // Notifications get 202 with no body.
    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    assert_eq!(post_raw(&ep.url, t, &[], &note).await, (202, String::new()));
    // Unsupported protocol header → 400.
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    let bad = [("mcp-protocol-version", "1999-01-01")];
    assert_eq!(post_raw(&ep.url, t, &bad, &ping).await.0, 400);
    // Batches.
    let batch = json!([note, ping, { "jsonrpc": "2.0", "id": 2, "method": "nope" }]);
    let (st, body) = post_raw(&ep.url, t, &[], &batch).await;
    assert_eq!(st, 200);
    let arr: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(arr.as_array().unwrap().len(), 2);
    assert_eq!(arr[1]["error"]["code"], protocol::METHOD_NOT_FOUND);
    // GET/DELETE → 405 (no SSE stream, no MCP sessions).
    for m in [reqwest::Method::GET, reqwest::Method::DELETE] {
        let r = client()
            .request(m, &ep.url)
            .header("authorization", format!("Bearer {}", ep.token))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 405);
    }
}

#[tokio::test]
async fn tools_list_matches_tools_json() {
    let (s, _rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    let ep = s.register_session("s1", "tab1");
    let v = rpc(&ep.url, &ep.token, "tools/list", json!({})).await;
    assert_eq!(v["result"]["tools"], json!(protocol::catalog().tools));
    let add = v["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "add_elements")
        .unwrap();
    assert_eq!(add["annotations"]["readOnlyHint"], false);
}

#[tokio::test]
async fn tools_call_round_trips_through_sink() {
    let (s, rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    auto_respond(s.clone(), rx);
    let ep = s.register_session("s1", "tab1");
    let args = json!({ "name": "get_selection", "arguments": {} });
    let v = rpc(&ep.url, &ep.token, "tools/call", args).await;
    assert_eq!(v["result"]["isError"], false);
    let echo = result_json(&v);
    assert_eq!(echo["tool"], "get_selection");
    assert_eq!(echo["sessionId"], "s1");
    assert_eq!(echo["tabId"], "tab1");
    // Explicit tabId wins; args pass through untouched.
    let args = json!({ "name": "get_elements", "arguments": { "tabId": "tab9", "ids": ["a"] } });
    let echo = result_json(&rpc(&ep.url, &ep.token, "tools/call", args).await);
    assert_eq!(echo["tabId"], "tab9");
    assert_eq!(echo["args"]["ids"], json!(["a"]));
    // Unknown tool → JSON-RPC error.
    let v = rpc(&ep.url, &ep.token, "tools/call", json!({ "name": "rm_rf" })).await;
    assert_eq!(v["error"]["code"], protocol::INVALID_PARAMS);
}

#[tokio::test]
async fn tools_call_times_out() {
    let (s, _rx) = server(Duration::from_millis(100)).await;
    let ep = s.register_session("s1", "tab1");
    let v = rpc(
        &ep.url,
        &ep.token,
        "tools/call",
        json!({ "name": "list_tabs" }),
    )
    .await;
    assert_eq!(v["result"]["isError"], true);
    let text = v["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Timed out"), "{text}");
}

#[tokio::test]
async fn sessions_are_isolated_and_unregister_cancels() {
    let (s, mut rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    let a = s.register_session("A", "tabA");
    let b = s.register_session("B", "tabB");
    // Token A always acts as session A.
    let call = json!({ "name": "list_tabs" });
    let url = a.url.clone();
    let tok = a.token.clone();
    let pending = tokio::spawn(async move { rpc(&url, &tok, "tools/call", call).await });
    let req = rx.recv().await.unwrap();
    assert_eq!(
        (req.session_id.as_str(), req.tab_id.as_str()),
        ("A", "tabA")
    );
    // Unregistering B leaves A's call alone and revokes B's token.
    s.unregister_session("B");
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    assert_eq!(post_raw(&b.url, Some(&b.token), &[], &ping).await.0, 401);
    assert_eq!(post_raw(&a.url, Some(&a.token), &[], &ping).await.0, 200);
    // Unregistering A fails its in-flight call.
    s.unregister_session("A");
    let v = pending.await.unwrap();
    assert_eq!(v["result"]["isError"], true);
    assert!(!s.complete_tool_call(ToolCallResult {
        call_id: req.call_id,
        is_error: false,
        content: vec![],
    }));
}

struct AllowAll;
impl ApprovalHandler for AllowAll {
    fn request(&self, req: ApprovalRequest) -> ApprovalFuture {
        assert_eq!(req.tool_name, "WebFetch");
        Box::pin(async { PermissionDecision::AllowOnce })
    }
}

#[tokio::test]
async fn approve_tool_uses_handler_and_defaults_to_deny() {
    let (s, _rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    let ep = s.register_session("s1", "tab1");
    let call = json!({ "name": "approve", "arguments": { "tool_name": "WebFetch", "input": { "url": "x" } } });
    let v = rpc(&ep.url, &ep.token, "tools/call", call.clone()).await;
    assert_eq!(result_json(&v)["behavior"], "deny");
    s.set_approval_handler(Some(Arc::new(AllowAll)));
    let v = rpc(&ep.url, &ep.token, "tools/call", call).await;
    let r = result_json(&v);
    assert_eq!(r["behavior"], "allow");
    assert_eq!(r["updatedInput"], json!({ "url": "x" }));
}

async fn run_shim(url: String, token: String, input: &str) -> Vec<Value> {
    let (mut in_w, in_r) = tokio::io::duplex(1 << 16);
    let (out_w, mut out_r) = tokio::io::duplex(1 << 16);
    in_w.write_all(input.as_bytes()).await.unwrap();
    drop(in_w);
    super::shim::run(url, token, in_r, out_w).await.unwrap();
    let mut out = String::new();
    out_r.read_to_string(&mut out).await.unwrap();
    out.lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[tokio::test]
async fn shim_relays_stdio_to_server() {
    let (s, rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    auto_respond(s.clone(), rx);
    let ep = s.register_session("s1", "tab1");
    let input = [
        json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "list_tabs" } }),
    ]
    .iter()
    .map(|v| format!("{v}\n"))
    .collect::<String>();
    let mut out = run_shim(ep.url, ep.token, &format!("{input}not json\n")).await;
    out.sort_by_key(|v| v["id"].as_i64().unwrap_or(-1));
    assert_eq!(out.len(), 4, "{out:?}");
    assert_eq!(out[0]["error"]["code"], -32700);
    assert_eq!(out[1]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(out[2]["result"]["tools"], json!(protocol::catalog().tools));
    assert_eq!(result_json(&out[3])["sessionId"], "s1");
}

#[tokio::test]
async fn shim_maps_failures_to_jsonrpc_errors() {
    // Wrong token → HTTP 401 → error for requests, silence for notifications.
    let (s, _rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    let ep = s.register_session("s1", "tab1");
    let input = "{\"jsonrpc\":\"2.0\",\"id\":\"a\",\"method\":\"ping\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n";
    let out = run_shim(ep.url.clone(), "bad".into(), input).await;
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["id"], "a");
    assert!(out[0]["error"]["message"].as_str().unwrap().contains("401"));
    // App gone → unreachable error.
    let port = s.port();
    s.shutdown();
    drop(s);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let out = run_shim(format!("http://127.0.0.1:{port}/mcp"), ep.token, input).await;
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["error"]["code"], -32603);
    assert!(out[0]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("unreachable"));
}

#[tokio::test]
async fn add_image_paths_are_loaded_from_session_roots_before_forwarding() {
    let (s, rx) = server(DEFAULT_TOOL_TIMEOUT).await;
    auto_respond(s.clone(), rx);
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let (root, outside) = (base.join("session"), base.join("outside"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(root.join("p.gif"), b"GIF89a\x01\x00\x01\x00").unwrap();
    std::fs::write(outside.join("x.gif"), b"GIF89a\x01\x00\x01\x00").unwrap();
    let ep = s.register_session("s1", "tab1");

    // Before roots are set, paths are refused (inline data still goes through).
    let call = |args: Value| json!({ "name": "add_image", "arguments": args });
    let r = rpc(
        &ep.url,
        &ep.token,
        "tools/call",
        call(json!({ "path": "p.gif" })),
    )
    .await;
    assert_eq!(r["result"]["isError"], true);
    let r = rpc(
        &ep.url,
        &ep.token,
        "tools/call",
        call(json!({ "data": "R0lG", "mimeType": "image/gif" })),
    )
    .await;
    assert_eq!(result_json(&r)["args"]["data"], "R0lG");

    s.set_session_file_roots("s1", vec![root.clone()]);
    let r = rpc(
        &ep.url,
        &ep.token,
        "tools/call",
        call(json!({ "path": "p.gif", "x": 1 })),
    )
    .await;
    let args = &result_json(&r)["args"];
    assert!(args.get("path").is_none(), "{args}");
    assert_eq!(args["mimeType"], "image/gif");
    assert_eq!(args["data"], "R0lGODlhAQABAA==");
    assert_eq!(args["x"], 1);

    let r = rpc(
        &ep.url,
        &ep.token,
        "tools/call",
        call(json!({ "path": "../outside/x.gif" })),
    )
    .await;
    assert_eq!(r["result"]["isError"], true);
    assert!(r["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("outside the conversation's folders"));
}
