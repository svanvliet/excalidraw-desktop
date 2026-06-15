mod commands;
mod error;
mod menu;

use commands::files::{open_file, read_file_bytes, save_file, write_file_bytes};
use commands::scratch::{delete_scratch, list_scratch, read_scratch, write_scratch};

use tauri::{Emitter, Manager, RunEvent};

/// Event name shared with the frontend (`src/ipc/openEvents.ts`). Whenever
/// the OS hands us a file — via `RunEvent::Opened` on macOS, via CLI args
/// on Windows/Linux, or via the single-instance plugin for a second
/// invocation — we forward the path here.
const FILE_OPEN_EVENT: &str = "excalidraw://file-open";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance must be the *first* plugin so a second invocation
    // shuts itself down before any other plugin initialization runs.
    // Desktop-only; mobile targets don't support it.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // The 2nd invocation typically passes the file path in argv.
            // Forward each .excalidraw / .png path to the running window.
            for arg in argv.iter().skip(1) {
                if looks_like_openable(arg) {
                    let _ = app.emit(FILE_OPEN_EVENT, arg);
                }
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }));
    }

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            read_file_bytes,
            write_file_bytes,
            write_scratch,
            read_scratch,
            delete_scratch,
            list_scratch
        ])
        .setup(|app| {
            // First-launch CLI args. On macOS the file path arrives via
            // RunEvent::Opened instead so we just look for it on win/linux.
            #[cfg(not(target_os = "macos"))]
            {
                for arg in std::env::args().skip(1) {
                    if looks_like_openable(&arg) {
                        let _ = app.emit(FILE_OPEN_EVENT, arg);
                    }
                }
            }

            // Install the native menu bar and route custom item clicks
            // through to the frontend.
            #[cfg(desktop)]
            {
                let handle = app.handle();
                let menu = menu::build_menu(handle)?;
                app.set_menu(menu)?;
                app.on_menu_event(menu::forward_menu_event);
            }
            let _ = app;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // macOS Finder double-click while running, and "Open With" on launch,
        // both arrive here.
        if let RunEvent::Opened { urls } = event {
            for url in urls {
                let path = url.to_file_path().ok();
                let display = path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| url.to_string());
                if looks_like_openable(&display) {
                    let _ = app_handle.emit(FILE_OPEN_EVENT, display);
                }
            }
        }
    });
}

/// Cheap filter for paths we know how to open. Stops us from forwarding
/// random argv noise (e.g. `--flag`) to the frontend.
fn looks_like_openable(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".excalidraw") || lower.ends_with(".png")
}
