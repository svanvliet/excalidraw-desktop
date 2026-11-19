//! MCP wire helpers: protocol versions, the advertised tool catalog (from `src/agent/tools.json`),
//! and JSON-RPC envelopes. Pure functions; no I/O.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

/// Preferred MCP protocol version (same as T3 Code).
pub const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
/// Versions we accept from clients. Our feature use (tools only, JSON responses) is identical
/// across all of these.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
    &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// Internal tool used as Claude Code's `--permission-prompt-tool`; handled in Rust.
pub const APPROVE_TOOL: &str = "approve";

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

const TOOLS_JSON: &str = include_str!("../../../../src/agent/tools.json");

pub fn is_supported_version(v: &str) -> bool {
    SUPPORTED_PROTOCOL_VERSIONS.contains(&v)
}

/// MCP version negotiation: echo the client's version when we support it, else offer ours.
pub fn negotiate_version(requested: Option<&str>) -> &'static str {
    requested
        .and_then(|r| SUPPORTED_PROTOCOL_VERSIONS.iter().find(|v| **v == r))
        .copied()
        .unwrap_or(LATEST_PROTOCOL_VERSION)
}

pub struct Catalog {
    /// `tools/list` → `result.tools`.
    pub tools: Vec<Value>,
    /// Canvas tools forwarded to the webview.
    pub canvas: HashSet<String>,
}

fn to_mcp_tool(t: &Value, read_only: bool) -> Value {
    json!({
        "name": t["name"],
        "description": t["description"],
        "inputSchema": t["inputSchema"],
        "annotations": { "readOnlyHint": read_only },
    })
}

pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let doc: Value = serde_json::from_str(TOOLS_JSON).expect("tools.json is valid JSON");
        let mut tools = Vec::new();
        let mut canvas = HashSet::new();
        for t in doc["tools"].as_array().into_iter().flatten() {
            let read_only = t["readOnly"].as_bool().unwrap_or(false);
            tools.push(to_mcp_tool(t, read_only));
            if let Some(name) = t["name"].as_str() {
                canvas.insert(name.to_owned());
            }
        }
        // Internal tools must be listed so Claude can resolve `--permission-prompt-tool`.
        for t in doc["internalTools"].as_array().into_iter().flatten() {
            tools.push(to_mcp_tool(t, true));
        }
        Catalog { tools, canvas }
    })
}

pub fn ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn err(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

pub fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": is_error })
}

pub fn initialize_result(requested: Option<&str>) -> Value {
    json!({
        "protocolVersion": negotiate_version(requested),
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": {
            "name": crate::agent::adapter::MCP_SERVER_NAME,
            "title": "Excalidraw Desktop canvas",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_known_versions_and_falls_back() {
        assert_eq!(negotiate_version(Some("2025-03-26")), "2025-03-26");
        assert_eq!(
            negotiate_version(Some("1999-01-01")),
            LATEST_PROTOCOL_VERSION
        );
        assert_eq!(negotiate_version(None), LATEST_PROTOCOL_VERSION);
    }

    #[test]
    fn catalog_mirrors_tools_json() {
        let doc: Value = serde_json::from_str(TOOLS_JSON).unwrap();
        let c = catalog();
        let src = doc["tools"].as_array().unwrap();
        assert_eq!(c.canvas.len(), src.len());
        for t in src {
            let name = t["name"].as_str().unwrap();
            let listed = c.tools.iter().find(|x| x["name"] == name).unwrap();
            assert_eq!(listed["inputSchema"], t["inputSchema"]);
            assert_eq!(listed["description"], t["description"]);
            assert_eq!(listed["annotations"]["readOnlyHint"], t["readOnly"]);
        }
        assert!(c.tools.iter().any(|x| x["name"] == APPROVE_TOOL));
        assert!(!c.canvas.contains(APPROVE_TOOL));
    }
}
