//! Loopback MCP server, `--mcp-shim`, webview tool bridge. Owned by the MCP lane.
//!
//! Core-lane usage:
//! ```ignore
//! let server = McpServer::start_global(Arc::new(TauriToolSink(app.clone()))).await?;
//! server.set_approval_handler(Some(handler)); // Claude `--permission-prompt-tool`
//! let endpoint = server.register_session(&session_id, &tab_id); // -> McpEndpoint
//! server.set_session_file_roots(&session_id, roots); // folders add_image may read
//! // … on stop:
//! server.unregister_session(&session_id);
//! ```
pub mod images;
pub mod protocol;
pub mod server;
pub mod shim;

#[cfg(test)]
mod tests;

pub use server::{
    shim_command, ApprovalFuture, ApprovalHandler, ApprovalRequest, McpServer, McpServerOptions,
    TauriToolSink, ToolCallSink, DEFAULT_TOOL_TIMEOUT,
};
pub use shim::run_from_env as run_shim_from_env;
