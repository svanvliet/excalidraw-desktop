//! Scratch / autosave file storage for untitled tabs and pending session state.
//!
//! Untitled tabs can't be autosaved to a user file (there isn't one yet) so
//! we persist their contents into the OS app-data directory:
//!
//! `<appDataDir>/scratch/<key>.excalidraw`
//!
//! - macOS:    ~/Library/Application Support/com.svanvliet.excalidrawdesktop/scratch/
//! - Windows:  %APPDATA%\com.svanvliet.excalidrawdesktop\scratch\
//!
//! Keys are tab ids generated client-side. They have no `/` or `\`, but we
//! still sanitize defensively so a malformed key can't escape the scratch dir.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::AppError;

const SCRATCH_SUBDIR: &str = "scratch";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScratchEntry {
    pub key: String,
    pub contents: String,
}

/// Write the given contents to `<appDataDir>/scratch/<key>.excalidraw`,
/// creating the directory if needed.
#[tauri::command]
pub fn write_scratch(app: AppHandle, key: String, contents: String) -> Result<(), AppError> {
    let safe = sanitize_key(&key)?;
    let path = scratch_path(&app, &safe)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::io(parent.display().to_string(), e))?;
    }
    fs::write(&path, contents).map_err(|e| AppError::io(path.display().to_string(), e))
}

/// Read a scratch file by key. Missing keys return `None`.
#[tauri::command]
pub fn read_scratch(app: AppHandle, key: String) -> Result<Option<String>, AppError> {
    let safe = sanitize_key(&key)?;
    let path = scratch_path(&app, &safe)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::io(path.display().to_string(), e)),
    }
}

/// Delete a scratch file. Missing keys are a no-op.
#[tauri::command]
pub fn delete_scratch(app: AppHandle, key: String) -> Result<(), AppError> {
    let safe = sanitize_key(&key)?;
    let path = scratch_path(&app, &safe)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::io(path.display().to_string(), e)),
    }
}

/// Enumerate every scratch entry currently on disk.
///
/// Used by session restore to recover untitled tabs from a previous run.
#[tauri::command]
pub fn list_scratch(app: AppHandle) -> Result<Vec<ScratchEntry>, AppError> {
    let dir = scratch_dir(&app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| AppError::io(dir.display().to_string(), e))? {
        let entry = entry.map_err(|e| AppError::io(dir.display().to_string(), e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("excalidraw") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let contents =
            fs::read_to_string(&path).map_err(|e| AppError::io(path.display().to_string(), e))?;
        out.push(ScratchEntry {
            key: stem.to_string(),
            contents,
        });
    }
    Ok(out)
}

fn scratch_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("app_data_dir unavailable: {e}")))?;
    Ok(base.join(SCRATCH_SUBDIR))
}

fn scratch_path(app: &AppHandle, safe_key: &str) -> Result<PathBuf, AppError> {
    Ok(scratch_dir(app)?.join(format!("{safe_key}.excalidraw")))
}

/// Reject keys that contain anything that could escape the scratch dir.
fn sanitize_key(key: &str) -> Result<String, AppError> {
    if key.is_empty() {
        return Err(AppError::InvalidFile("scratch key is empty".into()));
    }
    if key.len() > 128 {
        return Err(AppError::InvalidFile("scratch key is too long".into()));
    }
    if key
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err(AppError::InvalidFile(format!(
            "scratch key contains invalid characters: {key:?}"
        )));
    }
    Ok(key.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_path_separators() {
        assert!(sanitize_key("../etc/passwd").is_err());
        assert!(sanitize_key("a/b").is_err());
        assert!(sanitize_key("a\\b").is_err());
    }

    #[test]
    fn sanitize_rejects_empty_and_overlong() {
        assert!(sanitize_key("").is_err());
        assert!(sanitize_key(&"a".repeat(129)).is_err());
    }

    #[test]
    fn sanitize_accepts_alphanumeric_dash_underscore() {
        assert_eq!(sanitize_key("tab-1_abc").unwrap(), "tab-1_abc");
        assert_eq!(sanitize_key("ABC").unwrap(), "ABC");
    }
}
