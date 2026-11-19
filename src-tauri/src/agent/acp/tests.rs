//! Adapter tests: launch args, handshake, translation from NDJSON fixtures, permissions.
use super::*;
use crate::agent::adapter::McpEndpoint;
use serde_json::json;
use std::path::PathBuf;

const COPILOT_TURN: &str = include_str!("../../../tests/fixtures/acp/copilot_turn.ndjson");
const CLAUDE_ACP_TURN: &str = include_str!("../../../tests/fixtures/acp/claude_acp_turn.ndjson");

fn cfg() -> SessionConfig {
    SessionConfig {
        engine: EngineKind::Copilot,
        tab_id: "tab-1".into(),
        binary: PathBuf::from("/usr/local/bin/copilot"),
        cwd: PathBuf::from("/tmp/ws"),
        attached_folder: None,
        use_host_config: false,
        model: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:4000/mcp".into(),
            token: "tok".into(),
            shim_command: vec!["/app/excalidraw".into(), "--mcp-shim".into()],
        },
        system_prompt: String::new(),
        resume_id: None,
    }
}

fn parse(line: &str) -> Value {
    serde_json::from_str(line).expect("valid JSON write")
}

fn resp(id: u64, result: Value) -> String {
    json!({"jsonrpc":"2.0","id":id,"result":result}).to_string()
}

fn err(id: u64, code: i64, message: &str) -> String {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}).to_string()
}

fn init_ok() -> Value {
    json!({"protocolVersion":1,"agentInfo":{"name":"Copilot","version":"1.0.110"},
           "agentCapabilities":{"loadSession":true},"authMethods":[]})
}

/// Runs initialize + session/new (sessionId `s1`) and returns the adapter plus all output.
fn ready(mut a: AcpAdapter, c: &SessionConfig) -> (AcpAdapter, AdapterOutput) {
    let mut all = a.start(c);
    let o = a.on_line(&resp(1, init_ok()));
    all.events.extend(o.events);
    all.writes.extend(o.writes);
    let o = a.on_line(&resp(2, json!({"sessionId":"s1"})));
    all.events.extend(o.events);
    all.writes.extend(o.writes);
    (a, all)
}

fn feed(a: &mut AcpAdapter, ndjson: &str) -> AdapterOutput {
    let mut all = AdapterOutput::default();
    for line in ndjson.lines() {
        let o = a.on_line(line);
        all.events.extend(o.events);
        all.writes.extend(o.writes);
    }
    all
}

fn tool_calls(events: &[AgentEvent]) -> Vec<(&str, &str, ToolSource, ToolCallStatus)> {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCall {
                call_id,
                name,
                source,
                status,
                ..
            } => Some((call_id.as_str(), name.as_str(), *source, *status)),
            _ => None,
        })
        .collect()
}

// ---- launch ------------------------------------------------------------------------------------

#[test]
fn copilot_sandbox_flags_are_always_present() {
    for host in [false, true] {
        for model in [None, Some("gpt-5".to_owned()), Some("  ".to_owned())] {
            let mut c = cfg();
            c.use_host_config = host;
            c.model = model.clone();
            let spec = AcpAdapter::copilot().launch_spec(&c);
            let a = &spec.args;
            assert_eq!(&a[..2], ["--acp", "--stdio"]);
            let excluded = a
                .iter()
                .find_map(|x| x.strip_prefix("--excluded-tools="))
                .expect("--excluded-tools");
            for tool in ["bash", "powershell", "edit", "create", "apply_patch"] {
                assert!(excluded.split(',').any(|t| t == tool), "{tool} excluded");
            }
            assert!(a.contains(&"--deny-tool=shell".to_owned()));
            assert!(a.contains(&"--deny-tool=write".to_owned()));
            assert!(a.contains(&"--allow-tool=excalidraw".to_owned()));
            assert!(a.contains(&"--no-ask-user".to_owned()));
            assert!(!a
                .iter()
                .any(|x| x.starts_with("--allow-all") || x == "--yolo"));
            assert_eq!(a.contains(&"--disable-builtin-mcps".to_owned()), !host);
            assert_eq!(a.contains(&"--no-custom-instructions".to_owned()), !host);
            let want_model = model.as_deref().map(str::trim).filter(|m| !m.is_empty());
            assert_eq!(
                a.iter().find_map(|x| x.strip_prefix("--model=")),
                want_model
            );
            assert!(spec.env_remove.contains(&"COPILOT_ALLOW_ALL".to_owned()));
            assert_eq!(
                spec.env_remove
                    .contains(&"COPILOT_CUSTOM_INSTRUCTIONS_DIRS".to_owned()),
                !host
            );
            assert_eq!(spec.program, c.binary);
            assert_eq!(spec.cwd, c.cwd);
        }
    }
}

#[test]
fn generic_launch_uses_flavor_args() {
    let a = AcpAdapter::generic(EngineKind::Claude, vec!["--acp".into()]);
    assert_eq!(a.kind(), EngineKind::Claude);
    let spec = a.launch_spec(&cfg());
    assert_eq!(spec.args, vec!["--acp".to_owned()]);
}

// ---- handshake ---------------------------------------------------------------------------------

#[test]
fn copilot_handshake_uses_http_mcp_and_meta() {
    let mut a = AcpAdapter::copilot();
    let out = a.start(&cfg());
    assert_eq!(out.writes.len(), 1);
    let init = parse(&out.writes[0]);
    assert_eq!(init["method"], "initialize");
    assert_eq!(init["params"]["protocolVersion"], 1);
    assert!(init["params"]["clientCapabilities"]["_meta"][copilot::META_KEY].is_object());

    let out = a.on_line(&resp(1, init_ok()));
    let new = parse(&out.writes[0]);
    assert_eq!(new["method"], "session/new");
    assert_eq!(new["params"]["cwd"], "/tmp/ws");
    let mcp = &new["params"]["mcpServers"][0];
    assert_eq!(mcp["type"], "http");
    assert_eq!(mcp["name"], "excalidraw");
    assert_eq!(mcp["url"], "http://127.0.0.1:4000/mcp");
    assert_eq!(mcp["headers"][0]["value"], "Bearer tok");

    let out = a.on_line(&resp(2, json!({"sessionId":"s1"})));
    assert!(out.writes.is_empty());
    assert_eq!(
        out.events,
        vec![AgentEvent::Ready {
            engine: EngineKind::Copilot,
            version: Some("1.0.110".into()),
            model: None,
            engine_session_id: Some("s1".into()),
        }]
    );
}

#[test]
fn generic_handshake_uses_stdio_shim_without_copilot_meta() {
    let mut a = AcpAdapter::generic(EngineKind::Claude, vec![]);
    let out = a.start(&cfg());
    assert!(parse(&out.writes[0])["params"]["clientCapabilities"]
        .get("_meta")
        .is_none());
    let out = a.on_line(&resp(1, init_ok()));
    let mcp = &parse(&out.writes[0])["params"]["mcpServers"][0];
    assert_eq!(mcp["command"], "/app/excalidraw");
    assert_eq!(mcp["args"], json!(["--mcp-shim"]));
    assert_eq!(mcp["env"][0]["name"], MCP_URL_ENV);
    assert_eq!(
        mcp["env"][1],
        json!({"name": MCP_TOKEN_ENV, "value": "tok"})
    );
}

#[test]
fn copilot_always_writes_model_via_config_option() {
    let mut c = cfg();
    c.model = Some("claude-sonnet-4.5".into());
    let mut a = AcpAdapter::copilot();
    a.start(&c);
    a.on_line(&resp(1, init_ok()));
    // Copilot reports the requested model as current but may not be running it (#5363).
    let out = a.on_line(&resp(
        2,
        json!({"sessionId":"s1","configOptions":[{"id":"model","name":"Model","category":"model",
            "type":"select","currentValue":"claude-sonnet-4.5",
            "options":[{"value":"claude-sonnet-4.5","name":"Sonnet"}]}]}),
    ));
    let w = parse(&out.writes[0]);
    assert_eq!(w["method"], "session/set_config_option");
    assert_eq!(w["params"]["configId"], "model");
    assert_eq!(w["params"]["value"], "claude-sonnet-4.5");
    assert!(
        matches!(&out.events[0], AgentEvent::Ready { model: Some(m), .. } if m == "claude-sonnet-4.5")
    );
    // A failed selection is a non-fatal error.
    let out = a.on_line(&err(3, -32602, "unknown model"));
    assert!(matches!(
        &out.events[0],
        AgentEvent::Error {
            kind: ErrorKind::Other,
            fatal: false,
            ..
        }
    ));
}

#[test]
fn generic_sets_model_only_when_it_differs() {
    let mut c = cfg();
    c.model = Some("opus".into());
    let mut a = AcpAdapter::generic(EngineKind::Claude, vec![]);
    a.start(&c);
    a.on_line(&resp(1, init_ok()));
    let out = a.on_line(&resp(
        2,
        json!({"sessionId":"s1","models":{"currentModelId":"opus","availableModels":[]}}),
    ));
    assert!(out.writes.is_empty());

    let mut a = AcpAdapter::generic(EngineKind::Claude, vec![]);
    a.start(&c);
    a.on_line(&resp(1, init_ok()));
    let out = a.on_line(&resp(
        2,
        json!({"sessionId":"s1","models":{"currentModelId":"sonnet","availableModels":[]}}),
    ));
    let w = parse(&out.writes[0]);
    assert_eq!(w["method"], "session/set_model");
    assert_eq!(w["params"]["modelId"], "opus");
}

#[test]
fn prompts_before_ready_are_queued_and_system_prompt_is_prepended_once() {
    let mut c = cfg();
    c.system_prompt = "You draw diagrams.".into();
    let mut a = AcpAdapter::copilot();
    a.start(&c);
    let out = a.prompt("t1", "draw a cat");
    assert_eq!(
        out.events,
        vec![AgentEvent::TurnStarted {
            turn_id: "t1".into()
        }]
    );
    assert!(out.writes.is_empty());
    a.on_line(&resp(1, init_ok()));
    let out = a.on_line(&resp(2, json!({"sessionId":"s1"})));
    assert!(matches!(out.events[0], AgentEvent::Ready { .. }));
    let p = parse(&out.writes[0]);
    assert_eq!(p["method"], "session/prompt");
    assert_eq!(p["id"], 3);
    assert_eq!(p["params"]["sessionId"], "s1");
    assert_eq!(
        p["params"]["prompt"],
        json!([{"type":"text","text":"You draw diagrams."},{"type":"text","text":"draw a cat"}])
    );
    a.on_line(&resp(3, json!({"stopReason":"end_turn"})));
    let out = a.prompt("t2", "again");
    assert_eq!(
        parse(&out.writes[0])["params"]["prompt"],
        json!([{"type":"text","text":"again"}])
    );
}

#[test]
fn system_prompt_is_deferred_past_slash_commands() {
    let mut c = cfg();
    c.system_prompt = "SYS".into();
    let (mut a, _) = ready(AcpAdapter::copilot(), &c);
    let out = a.prompt("t1", "/compact");
    assert_eq!(
        parse(&out.writes[0])["params"]["prompt"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    a.on_line(&resp(3, json!({"stopReason":"end_turn"})));
    let out = a.prompt("t2", "hello");
    assert_eq!(parse(&out.writes[0])["params"]["prompt"][0]["text"], "SYS");
}

#[test]
fn resume_uses_session_load_and_falls_back_to_new() {
    let mut c = cfg();
    c.resume_id = Some("old".into());
    c.system_prompt = "SYS".into();
    let mut a = AcpAdapter::copilot();
    a.start(&c);
    let out = a.on_line(&resp(1, init_ok()));
    let w = parse(&out.writes[0]);
    assert_eq!(w["method"], "session/load");
    assert_eq!(w["params"]["sessionId"], "old");
    let out = a.on_line(&resp(2, Value::Null));
    assert!(
        matches!(&out.events[0], AgentEvent::Ready { engine_session_id: Some(s), .. } if s == "old")
    );
    // The resumed conversation already has the instructions.
    let out = a.prompt("t1", "hi");
    assert_eq!(
        parse(&out.writes[0])["params"]["prompt"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let mut a = AcpAdapter::copilot();
    a.start(&c);
    a.on_line(&resp(1, init_ok()));
    let out = a.on_line(&err(2, -32603, "Session directory no longer exists"));
    assert!(out.events.is_empty());
    assert_eq!(parse(&out.writes[0])["method"], "session/new");
}

#[test]
fn auth_failure_in_handshake_is_fatal_not_logged_in() {
    let mut a = AcpAdapter::copilot();
    a.start(&cfg());
    a.prompt("t1", "hi");
    a.on_line(&resp(1, init_ok()));
    let out = a.on_line(&err(2, -32000, "Authentication required"));
    assert!(matches!(
        &out.events[0],
        AgentEvent::Error {
            kind: ErrorKind::NotLoggedIn,
            fatal: true,
            ..
        }
    ));
    assert_eq!(
        out.events[1],
        AgentEvent::TurnEnded {
            turn_id: "t1".into(),
            stop_reason: StopReason::Error,
            usage: None
        }
    );
    let out = a.prompt("t2", "again");
    assert!(matches!(
        &out.events[1],
        AgentEvent::Error {
            kind: ErrorKind::Crashed,
            ..
        }
    ));
}

#[test]
fn missing_session_id_is_protocol_error() {
    let mut a = AcpAdapter::copilot();
    a.start(&cfg());
    a.on_line(&resp(1, init_ok()));
    let out = a.on_line(&resp(2, json!({})));
    assert!(matches!(
        &out.events[0],
        AgentEvent::Error {
            kind: ErrorKind::Protocol,
            fatal: true,
            ..
        }
    ));
}

// ---- translation -------------------------------------------------------------------------------

#[test]
fn copilot_fixture_translates_to_canonical_events() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "draw");
    let out = feed(&mut a, COPILOT_TURN);

    let texts: Vec<_> = out
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::TextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["Drawing ", "done."]);
    assert!(out.events.contains(&AgentEvent::ThinkingDelta {
        turn_id: "t1".into(),
        text: "Planning the diagram".into()
    }));
    assert!(out.events.contains(&AgentEvent::Plan {
        turn_id: "t1".into(),
        entries: vec![
            PlanEntry {
                content: "Add boxes".into(),
                status: "in_progress".into()
            },
            PlanEntry {
                content: "Connect arrows".into(),
                status: "pending".into()
            },
        ]
    }));

    let calls = tool_calls(&out.events);
    assert!(calls.contains(&(
        "tc1",
        "mcp__excalidraw__add_elements",
        ToolSource::Canvas,
        ToolCallStatus::Pending
    )));
    assert!(calls.contains(&(
        "tc1",
        "mcp__excalidraw__add_elements",
        ToolSource::Canvas,
        ToolCallStatus::Completed
    )));
    assert!(calls.contains(&(
        "tc2",
        "web_fetch",
        ToolSource::Builtin,
        ToolCallStatus::Pending
    )));
    let completed_output = out.events.iter().find_map(|e| match e {
        AgentEvent::ToolCall {
            status: ToolCallStatus::Completed,
            output,
            ..
        } => output.clone(),
        _ => None,
    });
    assert_eq!(completed_output.as_deref(), Some("Added 1 element"));

    // Canvas permission auto-approved with allow_once; the web fetch is surfaced to the user.
    let auto = out
        .writes
        .iter()
        .map(|w| parse(w))
        .find(|w| w["id"] == 100)
        .unwrap();
    assert_eq!(
        auto["result"]["outcome"],
        json!({"outcome":"selected","optionId":"allow"})
    );
    assert!(!out.writes.iter().any(|w| parse(w)["id"] == 101));
    let perm = out
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::PermissionRequest {
                turn_id,
                request_id,
                tool_name,
                title,
                detail,
            } => Some((turn_id, request_id, tool_name, title, detail)),
            _ => None,
        })
        .unwrap();
    assert_eq!(perm.0, "t1");
    assert_eq!(perm.2, "web_fetch");
    assert_eq!(perm.3, "Fetching https://example.com");
    assert_eq!(perm.4.as_deref(), Some(r#"{"url":"https://example.com"}"#));

    // Normal idle (no async shell) does not settle; the prompt response does, with usage.
    assert_eq!(
        out.events.last(),
        Some(&AgentEvent::TurnEnded {
            turn_id: "t1".into(),
            stop_reason: StopReason::EndTurn,
            usage: Some(Usage {
                input_tokens: Some(120),
                output_tokens: Some(45),
                premium_requests: None
            })
        })
    );
    assert_eq!(
        out.events
            .iter()
            .filter(|e| matches!(e, AgentEvent::TurnEnded { .. }))
            .count(),
        1
    );
}

#[test]
fn claude_acp_fixture_names_tools_from_meta() {
    let (mut a, _) = ready(AcpAdapter::generic(EngineKind::Claude, vec![]), &cfg());
    a.prompt("t1", "hi");
    let out = feed(&mut a, CLAUDE_ACP_TURN);
    let calls = tool_calls(&out.events);
    assert_eq!(
        calls,
        vec![
            (
                "t1",
                "mcp__excalidraw__get_scene",
                ToolSource::Canvas,
                ToolCallStatus::Pending
            ),
            (
                "t1",
                "mcp__excalidraw__get_scene",
                ToolSource::Canvas,
                ToolCallStatus::Completed
            ),
            ("t2", "Read", ToolSource::Builtin, ToolCallStatus::Pending),
            (
                "t3",
                "mcp__github__search",
                ToolSource::Host,
                ToolCallStatus::Running
            ),
        ]
    );
    assert!(out.events.iter().any(|e| matches!(
        e,
        AgentEvent::ToolCall { call_id, output: Some(o), .. } if call_id == "t1" && o == r#"{"elements":[]}"#
    )));
    assert!(matches!(
        out.events.last(),
        Some(AgentEvent::TurnEnded {
            stop_reason: StopReason::MaxTurns,
            ..
        })
    ));
}

#[test]
fn canvas_tool_name_accepts_engine_spellings() {
    for s in [
        "mcp__excalidraw__add_elements",
        "excalidraw-add_elements",
        "excalidraw/add_elements",
        "excalidraw.add_elements",
        "excalidraw: add_elements (2 elements)",
    ] {
        assert_eq!(canvas_tool_name(s).as_deref(), Some("add_elements"), "{s}");
    }
    for s in ["excalidrawish-x", "github-search", "excalidraw", "Read"] {
        assert_eq!(canvas_tool_name(s), None, "{s}");
    }
}

#[test]
fn updates_outside_a_turn_or_for_other_sessions_are_dropped() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    let out = feed(&mut a, COPILOT_TURN.lines().nth(2).unwrap());
    assert!(out.events.is_empty());
}

#[test]
fn stop_reasons_map() {
    for (wire, want) in [
        ("end_turn", StopReason::EndTurn),
        ("cancelled", StopReason::Cancelled),
        ("max_tokens", StopReason::MaxTurns),
        ("refusal", StopReason::Refusal),
    ] {
        let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
        a.prompt("t", "x");
        let out = a.on_line(&resp(3, json!({ "stopReason": wire })));
        assert!(
            matches!(&out.events[0], AgentEvent::TurnEnded { stop_reason, .. } if *stop_reason == want),
            "{wire}"
        );
    }
}

// ---- permissions -------------------------------------------------------------------------------

fn permission_line(id: u64, call: &str, title: &str) -> String {
    json!({"jsonrpc":"2.0","id":id,"method":"session/request_permission","params":{
        "sessionId":"s1","toolCall":{"toolCallId":call,"title":title},
        "options":[{"optionId":"a1","name":"Allow","kind":"allow_once"},
                   {"optionId":"aa","name":"Always","kind":"allow_always"},
                   {"optionId":"r1","name":"Reject","kind":"reject_once"}]}})
    .to_string()
}

fn first_request_id(out: &AdapterOutput) -> String {
    out.events
        .iter()
        .find_map(|e| match e {
            AgentEvent::PermissionRequest { request_id, .. } => Some(request_id.clone()),
            _ => None,
        })
        .expect("permission request")
}

#[test]
fn permission_decisions_map_to_option_ids() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "x");
    for (decision, option) in [
        (PermissionDecision::AllowOnce, "a1"),
        (PermissionDecision::Deny, "r1"),
        (PermissionDecision::AllowForConversation, "a1"),
    ] {
        let out = a.on_line(&permission_line(50, &format!("c-{option}"), "Run thing"));
        assert!(out.writes.is_empty());
        let rid = first_request_id(&out);
        let out = a.respond_permission(&rid, decision);
        let w = parse(&out.writes[0]);
        assert_eq!(w["id"], 50);
        assert_eq!(
            w["result"]["outcome"],
            json!({"outcome":"selected","optionId":option})
        );
        assert!(a.respond_permission(&rid, decision).writes.is_empty());
    }
    // "Run thing" is now allowed for the conversation: auto-approved, no prompt.
    let out = a.on_line(&permission_line(51, "c-again", "Run thing"));
    assert!(out
        .events
        .iter()
        .all(|e| !matches!(e, AgentEvent::PermissionRequest { .. })));
    assert_eq!(parse(&out.writes[0])["result"]["outcome"]["optionId"], "a1");
}

#[test]
fn deny_without_reject_option_cancels() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "x");
    let line = json!({"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{
        "sessionId":"s1","toolCall":{"toolCallId":"c"},
        "options":[{"optionId":"a1","name":"Allow","kind":"allow_once"}]}})
    .to_string();
    let rid = first_request_id(&a.on_line(&line));
    let out = a.respond_permission(&rid, PermissionDecision::Deny);
    assert_eq!(
        parse(&out.writes[0])["result"]["outcome"],
        json!({"outcome":"cancelled"})
    );
}

#[test]
fn invalid_permission_params_and_unknown_requests_get_errors() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    let out =
        a.on_line(r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{}}"#);
    assert_eq!(parse(&out.writes[0])["error"]["code"], -32602);
    let out = a.on_line(r#"{"jsonrpc":"2.0","id":10,"method":"fs/read_text_file","params":{}}"#);
    assert_eq!(parse(&out.writes[0])["error"]["code"], -32601);
    assert!(a.on_line("not json").writes.is_empty());
}

// ---- cancel, errors, quirks --------------------------------------------------------------------

#[test]
fn cancel_answers_permissions_and_sends_session_cancel() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "x");
    a.on_line(&permission_line(60, "c", "Run thing"));
    let out = a.cancel();
    let writes: Vec<Value> = out.writes.iter().map(|w| parse(w)).collect();
    assert_eq!(writes[0]["id"], 60);
    assert_eq!(
        writes[0]["result"]["outcome"],
        json!({"outcome":"cancelled"})
    );
    assert_eq!(writes[1]["method"], "session/cancel");
    assert_eq!(writes[1]["params"]["sessionId"], "s1");
    assert!(writes[1].get("id").is_none());
    assert!(out.events.is_empty());
    let out = a.on_line(&err(3, -32800, "cancelled"));
    assert!(matches!(
        &out.events[0],
        AgentEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            ..
        }
    ));
}

#[test]
fn cancel_before_ready_ends_queued_turns() {
    let mut a = AcpAdapter::copilot();
    a.start(&cfg());
    a.prompt("t1", "x");
    let out = a.cancel();
    assert!(out.writes.is_empty());
    assert_eq!(
        out.events,
        vec![AgentEvent::TurnEnded {
            turn_id: "t1".into(),
            stop_reason: StopReason::Cancelled,
            usage: None
        }]
    );
    a.on_line(&resp(1, init_ok()));
    let out = a.on_line(&resp(2, json!({"sessionId":"s1"})));
    assert!(out.writes.is_empty(), "cancelled prompt is not sent");
}

#[test]
fn copilot_lost_session_is_fatal() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "x");
    let out = a.on_line(&err(
        3,
        -32603,
        "session event delivery failed: session not found: s1",
    ));
    assert!(matches!(
        &out.events[0],
        AgentEvent::TurnEnded {
            stop_reason: StopReason::Error,
            ..
        }
    ));
    assert!(matches!(
        &out.events[1],
        AgentEvent::Error {
            kind: ErrorKind::Crashed,
            fatal: true,
            ..
        }
    ));
}

#[test]
fn prompt_errors_are_classified() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "x");
    let out = a.on_line(&err(
        3,
        -32603,
        "You have exceeded your premium request quota",
    ));
    assert!(matches!(
        &out.events[0],
        AgentEvent::Error {
            kind: ErrorKind::QuotaExceeded,
            fatal: false,
            ..
        }
    ));
    assert!(matches!(&out.events[1], AgentEvent::TurnEnded { .. }));
}

#[test]
fn copilot_idle_settles_turn_held_by_async_shell() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "x");
    let lines = [
        json!({"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"s1","type":"assistant.turn_start","data":{}}}),
        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"sh","title":"server","kind":"execute","status":"in_progress","rawInput":{"command":"npm run dev","mode":"async"}}}}),
        json!({"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"s1","type":"assistant.idle","data":{}}}),
    ];
    let out = feed(&mut a, &lines.map(|l| l.to_string()).join("\n"));
    assert!(matches!(
        out.events.last(),
        Some(AgentEvent::TurnEnded {
            stop_reason: StopReason::EndTurn,
            ..
        })
    ));
    // The late prompt response is ignored.
    assert!(a
        .on_line(&resp(3, json!({"stopReason":"end_turn"})))
        .events
        .is_empty());
}

#[test]
fn stderr_auth_hint_reported_once() {
    let mut a = AcpAdapter::copilot();
    let out = a.on_stderr("Error: Not logged in. Run `copilot login`.");
    assert!(matches!(
        &out.events[0],
        AgentEvent::Error {
            kind: ErrorKind::NotLoggedIn,
            fatal: false,
            ..
        }
    ));
    assert!(a.on_stderr("not logged in").events.is_empty());
    assert!(a.on_stderr("loading…").events.is_empty());
}

#[test]
fn prompt_before_start_errors() {
    let mut a = AcpAdapter::copilot();
    let out = a.prompt("t1", "x");
    assert!(matches!(
        &out.events[1],
        AgentEvent::Error {
            kind: ErrorKind::Crashed,
            ..
        }
    ));
    assert!(matches!(&out.events[2], AgentEvent::TurnEnded { .. }));
}
