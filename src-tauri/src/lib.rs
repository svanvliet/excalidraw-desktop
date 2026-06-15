mod commands;
mod error;
mod menu;

use commands::files::{open_file, read_file_bytes, save_file, write_file_bytes};
use commands::scratch::{delete_scratch, list_scratch, read_scratch, write_scratch};

use std::path::PathBuf;
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::{Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};

/// Event name shared with the frontend (`src/ipc/openEvents.ts`). Whenever
/// the OS hands us a file — via `RunEvent::Opened` on macOS, via CLI args
/// on Windows/Linux, or via the single-instance plugin for a second
/// invocation — we forward the path here.
const FILE_OPEN_EVENT: &str = "excalidraw://file-open";

/// Directory inside the user's home where we drop log files. Chosen to be
/// easy to find and easy to share when triaging.
const LOG_DIR_NAME: &str = ".excalidraw-desktop";
const LOG_FILE_NAME: &str = "excalidraw-desktop";

/// PNG bytes for the app icon, embedded at compile time. Used to update
/// the window/Dock icon at runtime so `tauri dev` actually shows the
/// brand icon instead of the default executable badge.
const ICON_PNG_BYTES: &[u8] = include_bytes!("../icons/icon.png");

/// Resolve the absolute path for our log directory: `$HOME/.excalidraw-desktop`.
/// Returns `None` when there's no home (sandboxed envs, CI) — the log
/// plugin then falls back to its default appdata location, which is still
/// useful.
fn log_dir() -> Option<PathBuf> {
    #[allow(deprecated)]
    let home = std::env::home_dir()?;
    Some(home.join(LOG_DIR_NAME))
}

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
            log::info!("single-instance: 2nd invocation argv={:?}", argv);
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

    // Logging plugin. Writes to:
    //   * stdout (so `npm run tauri dev` shows everything live)
    //   * the webview devtools (so the JS console shows Rust logs too)
    //   * a rolling file at $HOME/.excalidraw-desktop/excalidraw-desktop.log
    //
    // Forwards every JS `console.*` call into the same sinks via the
    // `withWebview: true` capture in `attach_logger` from the JS side.
    let mut log_builder = tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::Webview),
        ])
        .level(log::LevelFilter::Debug)
        // Quiet the noisier third-party crates so our own logs stand out.
        .level_for("hyper", log::LevelFilter::Info)
        .level_for("tao", log::LevelFilter::Info)
        .level_for("wry", log::LevelFilter::Info)
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .format(|out, message, record| {
            out.finish(format_args!(
                "[{} {} {}] {}",
                chrono_like_timestamp(),
                record.level(),
                record.target(),
                message
            ))
        });
    if let Some(dir) = log_dir() {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("could not create log dir {dir:?}: {e}");
        } else {
            log_builder = log_builder.target(Target::new(TargetKind::Folder {
                path: dir,
                file_name: Some(LOG_FILE_NAME.to_string()),
            }));
        }
    }

    let app = builder
        .plugin(log_builder.build())
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
            log::info!(
                "setup: bootstrapping Excalidraw Desktop v{} on {}",
                app.package_info().version,
                std::env::consts::OS
            );
            if let Some(dir) = log_dir() {
                log::info!("setup: log dir = {}", dir.display());
            }

            // First-launch CLI args. On macOS the file path arrives via
            // RunEvent::Opened instead so we just look for it on win/linux.
            #[cfg(not(target_os = "macos"))]
            {
                for arg in std::env::args().skip(1) {
                    if looks_like_openable(&arg) {
                        log::info!("setup: forwarding cli file arg {arg}");
                        let _ = app.emit(FILE_OPEN_EVENT, arg);
                    }
                }
            }

            // Install the native menu bar and route custom item clicks
            // through to the frontend.
            #[cfg(desktop)]
            {
                let handle = app.handle();
                match menu::build_menu(handle) {
                    Ok(menu) => match app.set_menu(menu) {
                        Ok(_) => log::info!("setup: native menu installed"),
                        Err(e) => log::error!("setup: set_menu failed: {e}"),
                    },
                    Err(e) => log::error!("setup: build_menu failed: {e}"),
                }
                app.on_menu_event(menu::forward_menu_event);
            }

            // During `tauri dev` there is no .app bundle, so macOS shows the
            // default executable icon in the Dock. Set the window icon at
            // runtime so the Dock picks it up (on macOS, tao forwards the
            // first window's icon to NSApplication::setApplicationIconImage).
            // In a release build this is harmless: the bundled .icns wins
            // visually and this just keeps the in-window icon consistent.
            if let Some(window) = app.get_webview_window("main") {
                match tauri::image::Image::from_bytes(ICON_PNG_BYTES) {
                    Ok(image) => match window.set_icon(image) {
                        Ok(_) => log::info!("setup: window icon applied at runtime"),
                        Err(e) => log::warn!("setup: set_icon failed: {e}"),
                    },
                    Err(e) => log::warn!("setup: decode icon.png failed: {e}"),
                }
            }
            let _ = app;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        // macOS Finder double-click while running, and "Open With" on launch,
        // both arrive here. `RunEvent::Opened` is only emitted on macOS; on
        // Windows the same flow is handled by the single-instance plugin
        // forwarding argv from the second instance.
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = _event {
            log::info!("RunEvent::Opened urls={:?}", urls);
            for url in urls {
                let path = url.to_file_path().ok();
                let display = path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| url.to_string());
                if looks_like_openable(&display) {
                    let _ = _app_handle.emit(FILE_OPEN_EVENT, display);
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

/// Tiny ISO-ish UTC timestamp without pulling in the `chrono` crate.
/// Resolution is seconds — fine for human triage.
fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // YYYY-MM-DDTHH:MM:SS via integer math on UNIX seconds.
    let (year, month, day, hour, minute, second) = unix_to_ymdhms(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn unix_to_ymdhms(mut secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let second = (secs % 60) as u32;
    secs /= 60;
    let minute = (secs % 60) as u32;
    secs /= 60;
    let hour = (secs % 24) as u32;
    secs /= 24;
    let mut days = secs as i64;
    let mut year: i32 = 1970;
    loop {
        let dy = if is_leap(year) { 366 } else { 365 };
        if days < dy {
            break;
        }
        days -= dy;
        year += 1;
    }
    let months_len = [
        31,
        days_in_feb(year),
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month: u32 = 1;
    for &dlen in months_len.iter() {
        if days < dlen {
            break;
        }
        days -= dlen;
        month += 1;
    }
    let day = (days as u32) + 1;
    (year, month, day, hour, minute, second)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
fn days_in_feb(y: i32) -> i64 {
    if is_leap(y) {
        29
    } else {
        28
    }
}
