use super::*;
use crate::agent::adapter::McpEndpoint;
use std::path::PathBuf;

const THREAD: &str = "th-1";

fn cfg() -> SessionConfig {
    SessionConfig {
        engine: EngineKind::Codex,
        tab_id: "tab".into(),
        binary: PathBuf::from("/usr/local/bin/codex"),
        cwd: PathBuf::from("/tmp/scratch"),
        attached_folder: None,
        writable_roots: vec![PathBuf::from("/tmp/scratch")],
        use_host_config: true,
        model: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:5000/mcp".into(),
            token: "secret-token".into(),
            shim_command: vec!["/app/excalidraw".into(), "--mcp-shim".into()],
        },
        system_prompt: "You draw diagrams.".into(),
        resume_id: None,
    }
}

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/tests/fixtures/codex/{name}.ndjson",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn parse(line: &str) -> Value {
    serde_json::from_str(line).unwrap()
}

/// Writes that are requests: (method, id, params).
fn requests(writes: &[String]) -> Vec<(String, u64, Value)> {
    writes
        .iter()
        .map(|w| parse(w))
        .filter_map(|v| {
            Some((
                v.get("method")?.as_str()?.to_string(),
                v.get("id")?.as_u64()?,
                v.get("params").cloned().unwrap_or(Value::Null),
            ))
        })
        .collect()
}

fn find_req(writes: &[String], method: &str) -> (u64, Value) {
    requests(writes)
        .into_iter()
        .find(|(m, _, _)| m == method)
        .map(|(_, id, p)| (id, p))
        .unwrap_or_else(|| panic!("no {method} in {writes:#?}"))
}

fn respond(a: &mut CodexAdapter, id: u64, result: Value) -> AdapterOutput {
    a.on_line(&json!({ "id": id, "result": result }).to_string())
}

/// Drive the handshake to a ready thread; returns the accumulated output.
fn ready(cfg: &SessionConfig) -> (CodexAdapter, AdapterOutput) {
    let mut a = CodexAdapter::new();
    let mut all = a.start(cfg);
    let (id, _) = find_req(&all.writes, M_INITIALIZE);
    let out = respond(
        &mut a,
        id,
        json!({ "userAgent": "codex_cli_rs/0.156.1 (Mac OS; arm64)" }),
    );
    all.writes.extend(out.writes.clone());
    let (acct, _) = find_req(&out.writes, M_ACCOUNT_READ);
    respond(
        &mut a,
        acct,
        json!({ "account": { "type": "chatgpt" }, "requiresOpenaiAuth": true }),
    );
    let (tid, _) = find_req(&out.writes, M_THREAD_START);
    let out = respond(
        &mut a,
        tid,
        json!({ "thread": { "id": THREAD }, "model": "gpt-5.5" }),
    );
    all.events.extend(out.events);
    all.writes.extend(out.writes);
    (a, all)
}

fn start_turn(a: &mut CodexAdapter, codex_turn: &str) -> AdapterOutput {
    let out = a.prompt("t1", "hello");
    let (id, _) = find_req(&out.writes, M_TURN_START);
    respond(
        a,
        id,
        json!({ "turn": { "id": codex_turn, "status": "inProgress" } }),
    );
    out
}

fn notify(a: &mut CodexAdapter, method: &str, params: Value) -> AdapterOutput {
    a.on_line(&json!({ "method": method, "params": params }).to_string())
}

// ---- launch spec / handshake ----

#[test]
fn launch_spec_always_workspace_write_with_token_in_env_only() {
    for use_host_config in [true, false] {
        let mut c = cfg();
        c.use_host_config = use_host_config;
        let spec = CodexAdapter::new().launch_spec(&c);
        assert_eq!(spec.program, c.binary);
        assert_eq!(spec.args[0], "app-server");
        let joined = spec.args.join(" ");
        assert!(
            joined.contains("-c sandbox_mode=\"workspace-write\""),
            "{joined}"
        );
        assert!(
            joined.contains("-c approval_policy=\"on-request\""),
            "{joined}"
        );
        assert!(joined.contains("-c sandbox_workspace_write.network_access=false"));
        assert!(!joined.contains("danger-full-access") && !joined.contains("never"));
        assert!(!joined.contains("secret-token"));
        assert!(spec
            .env_set
            .contains(&(MCP_TOKEN_ENV.into(), "secret-token".into())));
        assert!(spec.env_remove.contains(&"OPENAI_API_KEY".to_string()));
        assert!(spec.env_remove.contains(&"CODEX_API_KEY".to_string()));
        assert_eq!(spec.cwd, c.cwd);
    }
}

#[test]
fn handshake_starts_read_only_thread_with_canvas_mcp() {
    let mut c = cfg();
    c.model = Some("gpt-5.5".into());
    let mut a = CodexAdapter::new();
    let out = a.start(&c);
    assert_eq!(out.writes.len(), 1);
    let (id, p) = find_req(&out.writes, M_INITIALIZE);
    assert_eq!(p["clientInfo"]["name"], CLIENT_NAME);
    assert_eq!(p["capabilities"]["experimentalApi"], true);

    let out = respond(
        &mut a,
        id,
        json!({ "userAgent": "codex_cli_rs/0.156.1 (x)" }),
    );
    assert_eq!(parse(&out.writes[0]), json!({ "method": "initialized" }));
    find_req(&out.writes, M_ACCOUNT_READ);
    let (tid, p) = find_req(&out.writes, M_THREAD_START);
    assert_eq!(p["sandbox"], "workspace-write");
    assert_eq!(p["approvalPolicy"], "on-request");
    assert_eq!(
        p["config"]["sandbox_workspace_write.writable_roots"],
        json!(["/tmp/scratch"])
    );
    assert_eq!(p["config"]["sandbox_workspace_write.network_access"], false);
    assert_eq!(p["approvalsReviewer"], "user");
    assert_eq!(p["cwd"], "/tmp/scratch");
    assert_eq!(p["model"], "gpt-5.5");
    assert_eq!(p["developerInstructions"], "You draw diagrams.");
    let server = &p["config"]["mcp_servers"]["excalidraw"];
    assert_eq!(server["url"], "http://127.0.0.1:5000/mcp");
    assert_eq!(server["bearer_token_env_var"], MCP_TOKEN_ENV);
    assert_eq!(server["default_tools_approval_mode"], "approve");
    assert!(!p.to_string().contains("secret-token"));
    assert!(p["config"].get("project_doc_max_bytes").is_none());

    let out = respond(
        &mut a,
        tid,
        json!({ "thread": { "id": THREAD }, "model": "gpt-5.5" }),
    );
    assert_eq!(
        out.events,
        vec![AgentEvent::Ready {
            engine: EngineKind::Codex,
            version: Some("0.156.1".into()),
            model: Some("gpt-5.5".into()),
            engine_session_id: Some(THREAD.into()),
        }]
    );
    assert_eq!(a.thread_id(), Some(THREAD));

    let out = a.prompt("t1", "draw a cat");
    assert_eq!(
        out.events,
        vec![AgentEvent::TurnStarted {
            turn_id: "t1".into()
        }]
    );
    let (_, p) = find_req(&out.writes, M_TURN_START);
    assert_eq!(p["threadId"], THREAD);
    assert_eq!(
        p["input"],
        json!([{ "type": "text", "text": "draw a cat" }])
    );
    assert_eq!(
        p["sandboxPolicy"],
        json!({ "type": "workspaceWrite", "writableRoots": ["/tmp/scratch"],
                "networkAccess": false, "excludeTmpdirEnvVar": true, "excludeSlashTmp": true })
    );
    assert_eq!(p["approvalPolicy"], "on-request");
}

#[test]
fn stdio_shim_used_when_no_url() {
    let mut c = cfg();
    c.mcp.url.clear();
    let server = excalidraw_server(&c.mcp);
    assert_eq!(server["command"], "/app/excalidraw");
    assert_eq!(server["args"], json!(["--mcp-shim"]));
    assert_eq!(server["env_vars"], json!([MCP_URL_ENV, MCP_TOKEN_ENV]));
    assert!(server.get("url").is_none());
    let spec = CodexAdapter::new().launch_spec(&c);
    assert!(spec.env_set.iter().any(|(k, _)| k == MCP_TOKEN_ENV));
}

#[test]
fn host_config_off_disables_user_servers_and_instructions() {
    let mut c = cfg();
    c.use_host_config = false;
    let mut a = CodexAdapter::new();
    let out = a.start(&c);
    let (id, _) = find_req(&out.writes, M_INITIALIZE);
    let out = respond(&mut a, id, json!({ "userAgent": "codex/0.200.0" }));
    assert!(requests(&out.writes)
        .iter()
        .all(|(m, _, _)| m != M_THREAD_START));
    let (cid, p) = find_req(&out.writes, M_CONFIG_READ);
    assert_eq!(p["includeLayers"], false);
    let out = respond(
        &mut a,
        cid,
        json!({ "config": { "mcp_servers": { "github": {"url": "x"}, "my.server": {"command": "y"}, "excalidraw": {} } } }),
    );
    let (_, p) = find_req(&out.writes, M_THREAD_START);
    let servers = &p["config"]["mcp_servers"];
    assert_eq!(servers["github"], json!({ "enabled": false }));
    assert_eq!(servers["my.server"], json!({ "enabled": false }));
    assert_eq!(servers["excalidraw"]["bearer_token_env_var"], MCP_TOKEN_ENV);
    assert_eq!(p["config"]["project_doc_max_bytes"], 0);
    assert_eq!(p["config"]["features.plugins"], false);
    assert_eq!(p["config"]["features.apps"], false);
}

#[test]
fn resume_falls_back_to_new_thread() {
    let mut c = cfg();
    c.resume_id = Some("old-thread".into());
    let mut a = CodexAdapter::new();
    let out = a.start(&c);
    let (id, _) = find_req(&out.writes, M_INITIALIZE);
    let out = respond(&mut a, id, json!({ "userAgent": "codex/0.156.1" }));
    let (rid, p) = find_req(&out.writes, M_THREAD_RESUME);
    assert_eq!(p["threadId"], "old-thread");
    assert_eq!(p["sandbox"], "workspace-write");
    let out = a.on_line(
        &json!({ "id": rid, "error": { "code": -32600, "message": "thread not found: old-thread" } })
            .to_string(),
    );
    assert!(out.events.is_empty());
    let (sid, p) = find_req(&out.writes, M_THREAD_START);
    assert!(p.get("threadId").is_none());
    let out = respond(&mut a, sid, json!({ "thread": { "id": "new" } }));
    assert!(
        matches!(&out.events[0], AgentEvent::Ready { engine_session_id: Some(t), .. } if t == "new")
    );
}

#[test]
fn codex_home_writer_conflict_is_reported() {
    let mut c = cfg();
    c.resume_id = Some("busy".into());
    let mut a = CodexAdapter::new();
    let out = a.start(&c);
    let (id, _) = find_req(&out.writes, M_INITIALIZE);
    let out = respond(&mut a, id, json!({ "userAgent": "codex/0.156.1" }));
    let (rid, _) = find_req(&out.writes, M_THREAD_RESUME);
    let out = a.on_line(
        &json!({ "id": rid, "error": { "code": -32600, "message": "thread busy already has an active writer" } })
            .to_string(),
    );
    assert!(out.writes.is_empty());
    assert!(matches!(
        &out.events[0],
        AgentEvent::Error { kind: ErrorKind::Other, fatal: true, message } if message.contains("another Codex client")
    ));
}

#[test]
fn old_codex_is_rejected() {
    let mut a = CodexAdapter::new();
    let out = a.start(&cfg());
    let (id, _) = find_req(&out.writes, M_INITIALIZE);
    let out = respond(
        &mut a,
        id,
        json!({ "userAgent": "codex_cli_rs/0.98.0 (x)" }),
    );
    assert!(out.writes.is_empty());
    assert!(matches!(
        out.events[0],
        AgentEvent::Error {
            kind: ErrorKind::UnsupportedVersion,
            fatal: true,
            ..
        }
    ));
}

#[test]
fn not_logged_in_is_fatal() {
    let mut a = CodexAdapter::new();
    let out = a.start(&cfg());
    let (id, _) = find_req(&out.writes, M_INITIALIZE);
    let out = respond(&mut a, id, json!({ "userAgent": "codex/0.156.1" }));
    let (acct, _) = find_req(&out.writes, M_ACCOUNT_READ);
    let out = respond(
        &mut a,
        acct,
        json!({ "account": null, "requiresOpenaiAuth": true }),
    );
    assert!(matches!(
        out.events[0],
        AgentEvent::Error {
            kind: ErrorKind::NotLoggedIn,
            fatal: true,
            ..
        }
    ));
}

#[test]
fn version_helpers() {
    assert_eq!(
        version_from_user_agent("codex_cli_rs/0.156.1 (Mac OS 15.5.0; arm64) vscode/1.0")
            .as_deref(),
        Some("0.156.1")
    );
    assert_eq!(version_from_user_agent("nope"), None);
    assert!(version_lt("0.98.0", CODEX_MIN_VERSION));
    assert!(version_lt("0.156.0-alpha.1", "0.156.1"));
    assert!(!version_lt("0.156.0", CODEX_MIN_VERSION));
    assert!(!version_lt("1.0.0", CODEX_MIN_VERSION));
}

// ---- turns ----

#[test]
fn prompt_before_ready_is_queued_and_cancel_drops_it() {
    let mut a = CodexAdapter::new();
    a.start(&cfg());
    let out = a.prompt("t1", "hi");
    assert_eq!(
        out.events,
        vec![AgentEvent::TurnStarted {
            turn_id: "t1".into()
        }]
    );
    assert!(out.writes.is_empty());
    let out = a.cancel();
    assert!(out.writes.is_empty());
    assert!(matches!(
        &out.events[0],
        AgentEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            ..
        }
    ));
}

#[test]
fn cancel_before_turn_id_interrupts_once_known() {
    let (mut a, _) = ready(&cfg());
    let out = a.prompt("t1", "hi");
    let (id, _) = find_req(&out.writes, M_TURN_START);
    assert!(a.cancel().writes.is_empty());
    let out = respond(&mut a, id, json!({ "turn": { "id": "turn-9" } }));
    let (_, p) = find_req(&out.writes, M_TURN_INTERRUPT);
    assert_eq!(p, json!({ "threadId": THREAD, "turnId": "turn-9" }));
    let out = notify(
        &mut a,
        N_TURN_COMPLETED,
        json!({ "threadId": THREAD, "turn": { "id": "turn-9", "status": "interrupted" } }),
    );
    assert!(matches!(
        &out.events[0],
        AgentEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            ..
        }
    ));
}

#[test]
fn second_prompt_while_busy_is_rejected() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    let out = a.prompt("t2", "again");
    assert!(out.writes.is_empty());
    assert!(matches!(
        out.events[0],
        AgentEvent::Error { fatal: false, .. }
    ));
}

#[test]
fn failed_turn_maps_quota_and_refusal() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    let out = notify(
        &mut a,
        N_TURN_COMPLETED,
        json!({ "threadId": THREAD, "turn": { "id": "turn-1", "status": "failed",
            "error": { "message": "You've hit your usage limit.", "codexErrorInfo": "usageLimitExceeded" } } }),
    );
    assert!(matches!(
        out.events[0],
        AgentEvent::Error {
            kind: ErrorKind::QuotaExceeded,
            fatal: false,
            ..
        }
    ));
    assert!(matches!(
        out.events[1],
        AgentEvent::TurnEnded {
            stop_reason: StopReason::Error,
            ..
        }
    ));

    // `error` notification first (not retried), then the failed turn: one Error only.
    let (mut b, _) = ready(&cfg());
    start_turn(&mut b, "turn-2");
    let out = notify(
        &mut b,
        N_ERROR,
        json!({ "threadId": THREAD, "turnId": "turn-2", "willRetry": false,
            "error": { "message": "blocked", "codexErrorInfo": "cyberPolicy" } }),
    );
    assert_eq!(out.events.len(), 1);
    let out = notify(
        &mut b,
        N_TURN_COMPLETED,
        json!({ "threadId": THREAD, "turn": { "id": "turn-2", "status": "failed",
            "error": { "message": "blocked", "codexErrorInfo": "cyberPolicy" } } }),
    );
    assert_eq!(
        out.events,
        vec![AgentEvent::TurnEnded {
            turn_id: "t1".into(),
            stop_reason: StopReason::Refusal,
            usage: None
        }]
    );
}

#[test]
fn retried_errors_and_sub_agent_threads_are_ignored() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    let out = notify(
        &mut a,
        N_ERROR,
        json!({ "threadId": THREAD, "turnId": "turn-1", "willRetry": true, "error": { "message": "reconnecting" } }),
    );
    assert!(out.events.is_empty());
    let out = notify(
        &mut a,
        N_AGENT_MESSAGE_DELTA,
        json!({ "threadId": "sub-agent", "turnId": "x", "itemId": "m", "delta": "hidden" }),
    );
    assert!(out.events.is_empty());
}

#[test]
fn canvas_mcp_tool_items_are_canvas_source() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    let item = json!({ "type": "mcpToolCall", "id": "call-1", "server": "excalidraw", "tool": "add_elements",
        "arguments": { "elements": [] }, "status": "completed",
        "result": { "content": [{ "type": "text", "text": "added 0" }] } });
    let out = notify(
        &mut a,
        N_ITEM_COMPLETED,
        json!({ "threadId": THREAD, "turnId": "turn-1", "item": item }),
    );
    assert_eq!(
        out.events,
        vec![AgentEvent::ToolCall {
            turn_id: "t1".into(),
            call_id: "call-1".into(),
            name: "mcp__excalidraw__add_elements".into(),
            title: Some("add_elements".into()),
            source: ToolSource::Canvas,
            status: ToolCallStatus::Completed,
            input: Some(json!({ "elements": [] })),
            output: Some("added 0".into()),
        }]
    );
    let item = json!({ "type": "mcpToolCall", "id": "call-2", "server": "github", "tool": "search",
        "arguments": {}, "status": "failed", "error": { "message": "boom" } });
    let out = notify(
        &mut a,
        N_ITEM_COMPLETED,
        json!({ "threadId": THREAD, "turnId": "turn-1", "item": item }),
    );
    assert!(matches!(
        &out.events[0],
        AgentEvent::ToolCall { source: ToolSource::Host, status: ToolCallStatus::Failed, output: Some(o), .. } if o == "boom"
    ));
}

// ---- approvals ----

fn command_approval(a: &mut CodexAdapter, rpc_id: u64, cmd: &str) -> AdapterOutput {
    a.on_line(
        &json!({ "id": rpc_id, "method": R_COMMAND_APPROVAL, "params": {
            "threadId": THREAD, "turnId": "turn-1", "itemId": "i", "reason": "why", "command": cmd, "cwd": "/tmp" } })
        .to_string(),
    )
}

fn request_id_of(out: &AdapterOutput) -> String {
    match &out.events[0] {
        AgentEvent::PermissionRequest { request_id, .. } => request_id.clone(),
        e => panic!("expected PermissionRequest, got {e:?}"),
    }
}

#[test]
fn command_approval_round_trips_and_remembers_session_grant() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    let out = command_approval(&mut a, 0, "ls");
    assert!(out.writes.is_empty());
    match &out.events[0] {
        AgentEvent::PermissionRequest {
            turn_id,
            tool_name,
            title,
            detail,
            ..
        } => {
            assert_eq!(turn_id, "t1");
            assert_eq!(tool_name, "shell");
            assert_eq!(title, "Run command: ls");
            assert_eq!(detail.as_deref(), Some("why\nin /tmp"));
        }
        e => panic!("{e:?}"),
    }
    let rid = request_id_of(&out);
    let out = a.respond_permission(&rid, PermissionDecision::AllowForConversation);
    assert_eq!(
        parse(&out.writes[0]),
        json!({ "id": 0, "result": { "decision": "acceptForSession" } })
    );
    // Unknown/duplicate ids are ignored.
    assert!(a
        .respond_permission(&rid, PermissionDecision::Deny)
        .writes
        .is_empty());

    let out = command_approval(&mut a, 1, "ls");
    assert!(out.events.is_empty());
    assert_eq!(
        parse(&out.writes[0]),
        json!({ "id": 1, "result": { "decision": "acceptForSession" } })
    );

    let out = command_approval(&mut a, 2, "rm -rf /");
    let rid = request_id_of(&out);
    let out = a.respond_permission(&rid, PermissionDecision::Deny);
    assert_eq!(
        parse(&out.writes[0]),
        json!({ "id": 2, "result": { "decision": "decline" } })
    );
}

#[test]
fn allow_all_accepts_once_without_a_codex_session_grant() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    let rid = request_id_of(&command_approval(&mut a, 0, "ls"));
    let out = a.respond_permission(&rid, PermissionDecision::AllowAll);
    assert_eq!(
        parse(&out.writes[0]),
        json!({ "id": 0, "result": { "decision": "accept" } })
    );
    assert_eq!(command_approval(&mut a, 1, "ls").events.len(), 1);
}

fn file_change(a: &mut CodexAdapter, rpc: u64, item: &str, paths: &[&str]) -> AdapterOutput {
    let changes: Vec<Value> = paths
        .iter()
        .map(|p| json!({ "path": p, "kind": {"type": "add"}, "diff": "" }))
        .collect();
    notify(
        a,
        N_ITEM_STARTED,
        json!({ "threadId": THREAD, "turnId": "turn-1",
                "item": { "type": "fileChange", "id": item, "changes": changes, "status": "inProgress" } }),
    );
    a.on_line(
        &json!({ "id": rpc, "method": R_FILE_CHANGE_APPROVAL, "params": {
            "threadId": THREAD, "turnId": "turn-1", "itemId": item } })
        .to_string(),
    )
}

#[test]
fn file_changes_inside_roots_are_auto_accepted_outside_need_a_card() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut c = cfg();
    c.cwd = root.clone();
    c.writable_roots = vec![root.clone()];
    let (mut a, _) = ready(&c);
    start_turn(&mut a, "turn-1");
    let inside = root.join("sub/new.md").to_string_lossy().into_owned();
    let out = file_change(&mut a, 20, "fc1", &[&inside, "hello.txt"]);
    assert!(out
        .events
        .iter()
        .all(|e| !matches!(e, AgentEvent::PermissionRequest { .. })));
    assert_eq!(
        parse(out.writes.last().unwrap()),
        json!({ "id": 20, "result": { "decision": "accept" } })
    );

    // One path outside the root: the whole change needs approval.
    let out = file_change(&mut a, 21, "fc2", &["hello.txt", "/etc/hosts"]);
    assert!(out.writes.is_empty());
    let rid = out
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::PermissionRequest {
                request_id, detail, ..
            } => {
                assert!(detail.as_deref().unwrap_or_default().contains("/etc/hosts"));
                Some(request_id.clone())
            }
            _ => None,
        })
        .unwrap();
    // "Allow for conversation" stays scoped to that file set and is never Codex's
    // session-wide patch approval.
    let out = a.respond_permission(&rid, PermissionDecision::AllowForConversation);
    assert_eq!(
        parse(&out.writes[0])["result"],
        json!({ "decision": "accept" })
    );
    let out = file_change(&mut a, 22, "fc3", &["/etc/hosts", "hello.txt"]);
    assert_eq!(parse(out.writes.last().unwrap())["id"], 22);
    let out = file_change(&mut a, 23, "fc4", &["/etc/passwd"]);
    assert!(out.writes.is_empty());

    // Unknown item (no paths) or a grant root outside the roots never auto-accepts.
    let out = a.on_line(
        &json!({ "id": 24, "method": R_FILE_CHANGE_APPROVAL, "params": {
            "threadId": THREAD, "turnId": "turn-1", "itemId": "nope" } })
        .to_string(),
    );
    assert!(out.writes.is_empty());
    let out = a.on_line(
        &json!({ "id": 25, "method": R_APPLY_PATCH_APPROVAL_V1, "params": {
            "conversationId": THREAD, "callId": "c", "fileChanges": { inside.clone(): {} },
            "grantRoot": "/" } })
        .to_string(),
    );
    assert!(out.writes.is_empty());
    let out = a.on_line(
        &json!({ "id": 26, "method": R_APPLY_PATCH_APPROVAL_V1, "params": {
            "conversationId": THREAD, "callId": "c", "fileChanges": { inside: {} } } })
        .to_string(),
    );
    assert_eq!(
        parse(&out.writes[0]),
        json!({ "id": 26, "result": { "decision": "approved" } })
    );
}

#[test]
fn cancel_answers_outstanding_approvals() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    command_approval(&mut a, 7, "ls");
    let out = a.cancel();
    assert_eq!(
        parse(&out.writes[0]),
        json!({ "id": 7, "result": { "decision": "cancel" } })
    );
    find_req(&out.writes, M_TURN_INTERRUPT);
}

#[test]
fn legacy_and_permission_approvals_use_their_wire_shapes() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    let out = a.on_line(
        &json!({ "id": 3, "method": R_EXEC_APPROVAL_V1, "params": { "conversationId": THREAD, "callId": "c", "command": ["git", "push"] } })
            .to_string(),
    );
    let rid = request_id_of(&out);
    let out = a.respond_permission(&rid, PermissionDecision::Deny);
    assert_eq!(
        parse(&out.writes[0])["result"],
        json!({ "decision": { "denied": { "rejection": "The user declined this request." } } })
    );

    let perms = json!({ "network": { "enabled": true } });
    let out = a.on_line(
        &json!({ "id": 4, "method": R_PERMISSIONS_APPROVAL, "params": { "threadId": THREAD, "turnId": "turn-1", "itemId": "x", "cwd": "/tmp", "permissions": perms } })
            .to_string(),
    );
    let rid = request_id_of(&out);
    let out = a.respond_permission(&rid, PermissionDecision::AllowOnce);
    assert_eq!(
        parse(&out.writes[0])["result"],
        json!({ "permissions": perms, "scope": "turn" })
    );
}

fn elicitation(server: &str, mode: &str, approval: bool) -> String {
    let meta = if approval {
        json!({ "codex_approval_kind": "mcp_tool_call", "persist": ["session", "always"],
            "tool_name": "create_issue", "tool_params": { "title": "x" } })
    } else {
        json!({})
    };
    json!({ "id": 5, "method": R_MCP_ELICITATION, "params": {
        "serverName": server, "threadId": THREAD, "turnId": "turn-1", "mode": mode,
        "message": "Allow the github MCP server to run tool \"create_issue\"?",
        "requestedSchema": { "type": "object", "properties": {} }, "_meta": meta } })
    .to_string()
}

#[test]
fn canvas_elicitations_are_auto_accepted() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    let out = a.on_line(&elicitation(MCP_SERVER_NAME, "form", true));
    assert!(out.events.is_empty());
    assert_eq!(
        parse(&out.writes[0]),
        json!({ "id": 5, "result": { "action": "accept", "content": {}, "_meta": { "persist": "session" } } })
    );
}

#[test]
fn host_mcp_tool_approvals_become_permission_requests() {
    let (mut a, _) = ready(&cfg());
    start_turn(&mut a, "turn-1");
    let out = a.on_line(&elicitation("github", "form", true));
    assert!(out.writes.is_empty());
    match &out.events[0] {
        AgentEvent::PermissionRequest {
            tool_name, detail, ..
        } => {
            assert_eq!(tool_name, "mcp__github__create_issue");
            assert_eq!(detail.as_deref(), Some(r#"{"title":"x"}"#));
        }
        e => panic!("{e:?}"),
    }
    let rid = request_id_of(&out);
    let out = a.respond_permission(&rid, PermissionDecision::Deny);
    assert_eq!(
        parse(&out.writes[0])["result"],
        json!({ "action": "decline" })
    );

    // Non-approval form / url elicitations can't be rendered: cancel.
    let out = a.on_line(&elicitation("github", "url", false));
    assert!(out.events.is_empty());
    assert_eq!(
        parse(&out.writes[0])["result"],
        json!({ "action": "cancel" })
    );
}

#[test]
fn unsupported_server_requests_get_method_not_found() {
    let (mut a, _) = ready(&cfg());
    let out = a.on_line(r#"{"id":9,"method":"item/tool/call","params":{}}"#);
    assert_eq!(parse(&out.writes[0])["error"]["code"], RPC_METHOD_NOT_FOUND);
}

#[test]
fn stderr_auth_error_reported_once() {
    let mut a = CodexAdapter::new();
    let out = a.on_stderr("Error: Not logged in. Run `codex login`.");
    assert!(matches!(
        out.events[0],
        AgentEvent::Error {
            kind: ErrorKind::NotLoggedIn,
            fatal: false,
            ..
        }
    ));
    assert!(a.on_stderr("Error: Not logged in").events.is_empty());
    assert!(a.on_stderr("INFO starting").events.is_empty());
}

// ---- recorded T3 Code transcripts (codex 0.156.1) ----

struct Replay {
    events: Vec<AgentEvent>,
    writes: Vec<String>,
}

/// Replays a T3 Code transcript: inbound notifications and server requests are fed verbatim;
/// inbound responses are re-addressed to whichever of our requests used the same method (T3
/// sends a few extra requests we don't, whose responses are skipped). `account/read`, which T3
/// doesn't send, is answered with a signed-in account. `expect_outbound turn/interrupt` marks
/// where the user pressed Stop.
fn replay(name: &str, decision: PermissionDecision) -> Replay {
    let mut a = CodexAdapter::new();
    let mut r = Replay {
        events: vec![],
        writes: vec![],
    };
    let mut outstanding: Vec<(String, u64)> = vec![];
    let absorb = |a: &mut CodexAdapter,
                  out: AdapterOutput,
                  r: &mut Replay,
                  outstanding: &mut Vec<(String, u64)>| {
        let mut queue = vec![out];
        while let Some(out) = queue.pop() {
            for (m, id, _) in requests(&out.writes) {
                if m == M_ACCOUNT_READ {
                    queue.push(respond(
                        a,
                        id,
                        json!({ "account": { "type": "chatgpt" }, "requiresOpenaiAuth": true }),
                    ));
                } else {
                    outstanding.push((m, id));
                }
            }
            for e in &out.events {
                if let AgentEvent::PermissionRequest { request_id, .. } = e {
                    queue.push(a.respond_permission(request_id, decision));
                }
            }
            r.events.extend(out.events);
            r.writes.extend(out.writes);
        }
    };
    let out = a.start(&cfg());
    absorb(&mut a, out, &mut r, &mut outstanding);
    let out = a.prompt("t1", "fixture prompt");
    absorb(&mut a, out, &mut r, &mut outstanding);
    for line in fixture(name).lines() {
        let entry = parse(line);
        let label = entry["label"].as_str().unwrap_or_default();
        let frame = &entry["frame"];
        let out = match entry["type"].as_str() {
            Some("emit_inbound") if frame.get("method").is_none() => {
                let Some(pos) = outstanding.iter().position(|(m, _)| m == label) else {
                    continue;
                };
                let (_, id) = outstanding.remove(pos);
                let mut frame = frame.clone();
                frame["id"] = json!(id);
                a.on_line(&frame.to_string())
            }
            Some("emit_inbound") => a.on_line(&frame.to_string()),
            Some("expect_outbound") if label == M_TURN_INTERRUPT => a.cancel(),
            _ => continue,
        };
        absorb(&mut a, out, &mut r, &mut outstanding);
    }
    r
}

fn text_of(events: &[AgentEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::TextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn last_agent_message(name: &str) -> String {
    fixture(name)
        .lines()
        .map(parse)
        .filter(|e| {
            e["label"] == N_ITEM_COMPLETED && e["frame"]["params"]["item"]["type"] == "agentMessage"
        })
        .map(|e| {
            e["frame"]["params"]["item"]["text"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .next_back()
        .unwrap()
}

#[test]
fn replay_simple_turn() {
    let r = replay("simple", PermissionDecision::AllowOnce);
    assert!(matches!(
        &r.events[0],
        AgentEvent::TurnStarted { turn_id } if turn_id == "t1"
    ));
    assert!(r.events.iter().any(|e| matches!(
        e,
        AgentEvent::Ready { version: Some(v), engine_session_id: Some(_), .. } if v == "0.156.1"
    )));
    assert_eq!(text_of(&r.events), last_agent_message("simple"));
    assert_eq!(
        r.events.last(),
        Some(&AgentEvent::TurnEnded {
            turn_id: "t1".into(),
            stop_reason: StopReason::EndTurn,
            usage: Some(Usage {
                input_tokens: Some(22730),
                output_tokens: Some(7),
                premium_requests: None
            }),
        })
    );
    assert!(!r
        .events
        .iter()
        .any(|e| matches!(e, AgentEvent::Error { .. })));
}

#[test]
fn replay_live_0_170() {
    let r = replay("live_0_170_simple", PermissionDecision::AllowOnce);
    assert!(r.events.iter().any(|e| matches!(
        e,
        AgentEvent::Ready { version: Some(v), .. } if v == "0.170.0"
    )));
    assert_eq!(text_of(&r.events), "ok");
    assert!(matches!(
        r.events.last(),
        Some(AgentEvent::TurnEnded {
            stop_reason: StopReason::EndTurn,
            usage: Some(_),
            ..
        })
    ));
    assert!(!r
        .events
        .iter()
        .any(|e| matches!(e, AgentEvent::Error { .. })));
}

#[test]
fn replay_command_approval() {
    let r = replay(
        "tool_call_read_only_on_request",
        PermissionDecision::AllowOnce,
    );
    let perm = r
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::PermissionRequest {
                tool_name, title, ..
            } => Some((tool_name, title)),
            _ => None,
        })
        .expect("permission request");
    assert_eq!(perm.0, "shell");
    assert!(perm.1.contains(".codex-probe-write-action.txt"));
    assert!(r
        .writes
        .iter()
        .any(|w| parse(w) == json!({ "id": 0, "result": { "decision": "accept" } })));
    assert!(r.events.iter().any(|e| matches!(
        e,
        AgentEvent::ToolCall { name, source: ToolSource::Builtin, status: ToolCallStatus::Completed, .. } if name == "shell"
    )));
    assert!(r
        .events
        .iter()
        .any(|e| matches!(e, AgentEvent::ThinkingDelta { .. })));
    let text = text_of(&r.events);
    assert!(text.ends_with(&last_agent_message("tool_call_read_only_on_request")));
    assert!(text.contains("\n\n"), "two agent messages are separated");
    assert!(matches!(
        r.events.last(),
        Some(AgentEvent::TurnEnded {
            stop_reason: StopReason::EndTurn,
            usage: Some(_),
            ..
        })
    ));
}

#[test]
fn replay_interrupt() {
    let r = replay("turn_interrupt", PermissionDecision::AllowOnce);
    let (_, p) = find_req(&r.writes, M_TURN_INTERRUPT);
    assert!(p["turnId"].as_str().is_some_and(|t| !t.is_empty()));
    assert!(matches!(
        r.events.last(),
        Some(AgentEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            ..
        })
    ));
}

#[test]
fn replay_todo_list_plan() {
    let r = replay("todo_list", PermissionDecision::AllowOnce);
    let plans: Vec<&Vec<PlanEntry>> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Plan { entries, .. } => Some(entries),
            _ => None,
        })
        .collect();
    assert_eq!(plans.len(), 2);
    assert!(plans
        .iter()
        .flat_map(|p| p.iter())
        .all(|e| !e.content.is_empty()
            && ["pending", "in_progress", "completed"].contains(&e.status.as_str())));
    assert!(plans[1].iter().all(|e| e.status == "completed"));
    assert!(matches!(
        r.events.last(),
        Some(AgentEvent::TurnEnded {
            stop_reason: StopReason::EndTurn,
            ..
        })
    ));
}

// ---- live smoke (manual) ----

/// `CODEX_BIN=/opt/homebrew/bin/codex cargo test --lib codex::tests::live_smoke -- --ignored --nocapture`
/// Spawns the real binary with our LaunchSpec and runs one tiny turn (uses a little quota).
/// `CODEX_RECORD=<path>` writes the raw stdout/stdin transcript as NDJSON.
#[test]
#[ignore]
fn live_smoke() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let bin = std::env::var("CODEX_BIN").expect("set CODEX_BIN");
    let mut c = cfg();
    c.binary = bin.into();
    c.cwd = std::env::temp_dir();
    // No canvas server in this smoke: point at a closed port (optional server, startup grace).
    c.mcp.url = "http://127.0.0.1:9/mcp".into();
    c.system_prompt = "Reply tersely.".into();
    let mut a = CodexAdapter::new();
    let spec = a.launch_spec(&c);
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args).current_dir(&spec.cwd);
    for (k, v) in &spec.env_set {
        cmd.env(k, v);
    }
    for k in &spec.env_remove {
        cmd.env_remove(k);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn codex");
    let mut stdin = child.stdin.take().unwrap();
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    let tx2 = tx.clone();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        for l in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx.send((true, l));
        }
    });
    std::thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = tx2.send((false, l));
        }
    });
    let mut transcript: Vec<Value> = vec![];
    let mut events: Vec<AgentEvent> = vec![];
    let mut send =
        |out: AdapterOutput, transcript: &mut Vec<Value>, events: &mut Vec<AgentEvent>| {
            for w in &out.writes {
                transcript.push(json!({ "dir": "out", "frame": parse(w) }));
                writeln!(stdin, "{w}").unwrap();
            }
            stdin.flush().unwrap();
            for e in &out.events {
                eprintln!("EVENT {}", serde_json::to_string(e).unwrap());
            }
            events.extend(out.events);
        };
    send(a.start(&c), &mut transcript, &mut events);
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut prompted = false;
    while Instant::now() < deadline {
        let Ok((is_out, line)) = rx.recv_timeout(Duration::from_secs(1)) else {
            continue;
        };
        let out = if is_out {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                transcript.push(json!({ "dir": "in", "frame": v }));
            }
            a.on_line(&line)
        } else {
            eprintln!("STDERR {line}");
            a.on_stderr(&line)
        };
        send(out, &mut transcript, &mut events);
        if !prompted && events.iter().any(|e| matches!(e, AgentEvent::Ready { .. })) {
            prompted = true;
            send(
                a.prompt("t1", "Reply with exactly: ok"),
                &mut transcript,
                &mut events,
            );
        }
        if events.iter().any(|e| {
            matches!(
                e,
                AgentEvent::TurnEnded { .. } | AgentEvent::Error { fatal: true, .. }
            )
        }) {
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    if let Ok(path) = std::env::var("CODEX_RECORD") {
        let body: Vec<String> = transcript.iter().map(Value::to_string).collect();
        std::fs::write(path, body.join("\n") + "\n").unwrap();
    }
    assert!(
        events.iter().any(|e| matches!(e, AgentEvent::Ready { .. })),
        "{events:#?}"
    );
    assert!(
        events.iter().any(|e| matches!(
            e,
            AgentEvent::TurnEnded {
                stop_reason: StopReason::EndTurn,
                ..
            }
        )),
        "{events:#?}"
    );
    assert!(text_of(&events).to_lowercase().contains("ok"));
}

#[test]
fn model_list_and_live_switch() {
    let list = json!({"data":[
        {"id":"gpt-6.2-sol","model":"gpt-6.2-sol","displayName":"GPT-6.2-Sol","hidden":false},
        {"id":"old","model":"old","hidden":true},
        {"id":"x"}]});
    let ids: Vec<_> = model_options(&list).into_iter().map(|m| m.id).collect();
    assert_eq!(ids, ["gpt-6.2-sol", "x"]);

    let mut a = CodexAdapter::new();
    let out = a.set_model("gpt-6.2-sol");
    assert_eq!(
        out.events,
        vec![AgentEvent::ModelChanged {
            model: "gpt-6.2-sol".into()
        }]
    );
    assert_eq!(a.model.as_deref(), Some("gpt-6.2-sol"));
    assert!(a.set_model("gpt-6.2-sol").events.is_empty());
}
