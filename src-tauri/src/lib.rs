mod commands;
mod error;

use commands::files::{open_file, read_file_bytes, save_file, write_file_bytes};
use commands::scratch::{delete_scratch, list_scratch, read_scratch, write_scratch};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
