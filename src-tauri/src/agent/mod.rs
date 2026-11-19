//! AI agent integration ("bring your own agent"). Design: `docs/ai-integration.md`.
//!
//! Module ownership (parallel implementation lanes — keep edits inside your module):
//! - `events`, `adapter`, `tools.json`: shared contract. Change only with conductor sign-off.
//! - `process`, `detect`, `manager`: core lane (process lifecycle, binary discovery, sessions).
//! - `acp`: ACP lane (generic ACP + GitHub Copilot CLI `copilot --acp`).
//! - `claude`: Claude Code lane (`claude -p` stream-json).
//! - `codex`: Codex lane (`codex app-server`).
//! - `mcp`: MCP lane (loopback MCP server, `--mcp-shim`, webview tool bridge).
pub mod acp;
pub mod adapter;
pub mod claude;
pub mod codex;
pub mod detect;
pub mod events;
pub mod manager;
pub mod mcp;
pub mod process;
