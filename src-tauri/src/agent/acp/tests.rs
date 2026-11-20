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
        writable_roots: vec![PathBuf::from("/tmp/ws")],
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
            // Writes are pre-approved only inside the session's root; never unscoped `write`
            // (which would also approve shell redirections anywhere) and never shell.
            let allows: Vec<&str> = a
                .iter()
                .filter_map(|x| x.strip_prefix("--allow-tool="))
                .collect();
            assert_eq!(allows, ["write(/tmp/ws/**)", "excalidraw"]);
            assert!(a.contains(&"--disallow-temp-dir".to_owned()));
            assert!(!a.iter().any(|x| x.starts_with("--add-dir")));
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
fn copilot_folder_attached_mid_conversation_is_a_second_scoped_root() {
    let mut c = cfg();
    c.attached_folder = Some(PathBuf::from("/work/proj/"));
    c.writable_roots = vec![PathBuf::from("/tmp/ws"), PathBuf::from("/work/proj/")];
    let a = AcpAdapter::copilot().launch_spec(&c).args;
    assert!(a.contains(&"--allow-tool=write(/tmp/ws/**)".to_owned()));
    assert!(a.contains(&"--allow-tool=write(/work/proj/**)".to_owned()));
    assert!(a.contains(&"--add-dir=/work/proj/".to_owned()));
    assert!(!a
        .iter()
        .any(|x| x == "--allow-tool=write" || x == "--allow-tool=shell"));
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
    assert_eq!(
        out.events[0],
        AgentEvent::Models {
            available: vec![crate::agent::events::ModelOption {
                id: "claude-sonnet-4.5".into(),
                name: Some("Sonnet".into()),
            }]
        }
    );
    assert!(
        matches!(&out.events[1], AgentEvent::Ready { model: Some(m), .. } if m == "claude-sonnet-4.5")
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
fn session_models_are_reported_and_switchable_live() {
    let mut a = AcpAdapter::copilot();
    a.start(&cfg());
    a.on_line(&resp(1, init_ok()));
    let out = a.on_line(&resp(
        2,
        json!({"sessionId":"s1",
            "models":{"currentModelId":"gpt-5","availableModels":[
                {"modelId":"gpt-5","name":"GPT-5"},{"modelId":"claude-sonnet-4.5"}]},
            "configOptions":[{"id":"model","category":"model","type":"select",
                "currentValue":"gpt-5","options":[{"value":"gpt-5"}]}]}),
    ));
    assert!(
        out.writes.is_empty(),
        "no model requested, nothing to write"
    );
    let AgentEvent::Models { available } = &out.events[0] else {
        panic!("expected Models, got {:?}", out.events)
    };
    let ids: Vec<_> = available.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["gpt-5", "claude-sonnet-4.5"]);
    assert_eq!(available[0].name.as_deref(), Some("GPT-5"));
    assert!(matches!(&out.events[1], AgentEvent::Ready { model: Some(m), .. } if m == "gpt-5"));

    // Same model: no-op. New model: written via the config option, announced on success.
    assert_eq!(a.set_model("gpt-5"), AdapterOutput::default());
    let out = a.set_model("claude-sonnet-4.5");
    assert!(out.events.is_empty());
    let w = parse(&out.writes[0]);
    assert_eq!(w["method"], "session/set_config_option");
    assert_eq!(w["params"]["sessionId"], "s1");
    assert_eq!(w["params"]["value"], "claude-sonnet-4.5");
    let id = w["id"].as_u64().unwrap();
    let out = a.on_line(&resp(id, json!({})));
    assert_eq!(
        out.events,
        vec![AgentEvent::ModelChanged {
            model: "claude-sonnet-4.5".into()
        }]
    );
}

#[test]
fn set_model_before_ready_is_a_soft_error() {
    let mut a = AcpAdapter::copilot();
    a.start(&cfg());
    let out = a.set_model("gpt-5");
    assert!(out.writes.is_empty());
    assert!(matches!(
        &out.events[0],
        AgentEvent::Error { fatal: false, .. }
    ));
}

#[test]
fn copilot_cli_notices_are_not_assistant_text() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "hi");
    let chunk = |text: &str, message_id: Option<&str>| {
        let mut update = json!({"sessionUpdate":"agent_message_chunk",
            "content":{"type":"text","text":text}});
        if let Some(id) = message_id {
            update["messageId"] = json!(id);
        }
        json!({"jsonrpc":"2.0","method":"session/update",
            "params":{"sessionId":"s1","update":update}})
        .to_string()
    };
    let notices = [
        "Info: Disabled tools: bash, create, edit",
        "Info: Unknown tool name in the tool excludedlist: \"write_bash\"",
        "\nWarning: something odd",
    ];
    for n in notices {
        let out = a.on_line(&chunk(n, None));
        assert!(
            !out.events
                .iter()
                .any(|e| matches!(e, AgentEvent::TextDelta { .. })),
            "notice leaked: {n}"
        );
    }
    // Real replies carry a messageId, even if they happen to start with "Info: ".
    let out = a.on_line(&chunk("Info: here is your diagram", Some("m1")));
    assert!(
        matches!(&out.events[..], [AgentEvent::TextDelta { text, .. }] if text.starts_with("Info: "))
    );
    let out = a.on_line(&chunk("Plain text", None));
    assert!(matches!(&out.events[..], [AgentEvent::TextDelta { .. }]));

    // Generic ACP engines keep their text untouched.
    let (mut g, _) = ready(AcpAdapter::generic(EngineKind::Claude, vec![]), &cfg());
    g.prompt("t1", "hi");
    let out = g.on_line(&chunk("Info: generic", None));
    assert!(matches!(&out.events[..], [AgentEvent::TextDelta { .. }]));
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
fn allow_all_answers_allow_once_without_remembering() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "x");
    let rid = first_request_id(&a.on_line(&permission_line(60, "c1", "Run thing")));
    let out = a.respond_permission(&rid, PermissionDecision::AllowAll);
    assert_eq!(
        parse(&out.writes[0])["result"]["outcome"]["optionId"],
        "a1",
        "never allow_always on the wire"
    );
    let again = a.on_line(&permission_line(61, "c2", "Run thing"));
    assert!(again
        .events
        .iter()
        .any(|e| matches!(e, AgentEvent::PermissionRequest { .. })));
}

fn shell_permission_line(id: u64, call: &str, command: &str) -> String {
    json!({"jsonrpc":"2.0","id":id,"method":"session/request_permission","params":{
        "sessionId":"s1","toolCall":{"toolCallId":call,"title":"Run shell command","kind":"execute",
            "rawInput":{"command":command}},
        "options":[{"optionId":"a1","name":"Allow","kind":"allow_once"},
                   {"optionId":"r1","name":"Reject","kind":"reject_once"}]}})
    .to_string()
}

#[test]
fn shell_permission_detail_is_the_readable_command() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "x");
    let out = a.on_line(&shell_permission_line(80, "c1", "cd /tmp\nls -la"));
    assert!(matches!(
        &out.events[..],
        [.., AgentEvent::PermissionRequest { detail: Some(d), .. }] if d == "cd /tmp\nls -la"
    ));
}

#[test]
fn shell_grant_for_conversation_covers_only_that_command() {
    let (mut a, _) = ready(AcpAdapter::copilot(), &cfg());
    a.prompt("t1", "x");
    let rid = first_request_id(&a.on_line(&shell_permission_line(70, "c1", "npm test")));
    a.respond_permission(&rid, PermissionDecision::AllowForConversation);
    let same = a.on_line(&shell_permission_line(71, "c2", "npm test"));
    assert!(same
        .events
        .iter()
        .all(|e| !matches!(e, AgentEvent::PermissionRequest { .. })));
    assert_eq!(
        parse(&same.writes[0])["result"]["outcome"]["optionId"],
        "a1"
    );
    let other = a.on_line(&shell_permission_line(72, "c3", "rm -rf ~"));
    assert!(other.writes.is_empty());
    first_request_id(&other);
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

// ---- round trip against examples/fake_acp_agent.rs ---------------------------------------------

/// Drives the adapter against the real fake-agent process (built by `cargo test` alongside the
/// examples). Skipped when the example binary is not present.
#[test]
fn round_trip_with_fake_acp_agent() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    let exe = std::env::current_exe().unwrap();
    let bin = exe
        .parent()
        .and_then(|deps| deps.parent())
        .map(|dir| {
            dir.join("examples")
                .join(format!("fake_acp_agent{}", std::env::consts::EXE_SUFFIX))
        })
        .unwrap();
    if !bin.exists() {
        eprintln!("skipping: {} not built", bin.display());
        return;
    }
    let mut c = cfg();
    c.binary = bin.clone();
    let mut a = AcpAdapter::generic(EngineKind::Claude, vec![]);
    let spec = a.launch_spec(&c);
    let mut child = Command::new(&spec.program)
        .args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut write = |out: &AdapterOutput| {
        for w in &out.writes {
            writeln!(stdin, "{w}").unwrap();
        }
        stdin.flush().unwrap();
    };

    let mut events = Vec::new();
    write(&a.start(&c));
    write(&a.prompt("t1", "draw a box"));
    let ended = loop {
        let line = lines.next().expect("agent closed stdout").unwrap();
        let out = a.on_line(&line);
        write(&out);
        for e in out.events {
            if let AgentEvent::PermissionRequest { request_id, .. } = &e {
                write(&a.respond_permission(request_id, PermissionDecision::AllowOnce));
            }
            let done = matches!(e, AgentEvent::TurnEnded { .. });
            events.push(e);
            if done {
                break;
            }
        }
        if let Some(AgentEvent::TurnEnded { .. }) = events.last() {
            break events.last().cloned().unwrap();
        }
    };
    let _ = child.kill();
    let _ = child.wait();

    // A `models` notice may precede Ready; Ready is the first non-model event.
    let first = events
        .iter()
        .find(|e| !matches!(e, AgentEvent::Models { .. }))
        .expect("events");
    assert!(matches!(first, AgentEvent::Ready { version: Some(v), .. } if v == "0.1.0"));
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::TextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(text.contains("You said: draw a box"), "{text}");
    assert!(text.contains("Permission outcome: allow-once."), "{text}");
    let calls = tool_calls(&events);
    assert!(calls.contains(&(
        "fake-tool-1",
        "mcp__excalidraw__add_elements",
        ToolSource::Canvas,
        ToolCallStatus::Completed
    )));
    assert!(calls
        .iter()
        .any(|c| c.0 == "fake-tool-2" && c.3 == ToolCallStatus::Completed));
    assert_eq!(
        ended,
        AgentEvent::TurnEnded {
            turn_id: "t1".into(),
            stop_reason: StopReason::EndTurn,
            usage: Some(Usage {
                input_tokens: Some(42),
                output_tokens: Some(7),
                premium_requests: None
            })
        }
    );
}
