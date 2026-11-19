// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Stdio MCP relay for agent engines: must run before Tauri (no window, no single-instance,
    // nothing on stdout but protocol messages).
    if std::env::args_os()
        .nth(1)
        .is_some_and(|a| a == excalidraw_desktop_lib::agent::adapter::MCP_SHIM_FLAG)
    {
        std::process::exit(excalidraw_desktop_lib::agent::mcp::run_shim_from_env());
    }
    excalidraw_desktop_lib::run()
}
