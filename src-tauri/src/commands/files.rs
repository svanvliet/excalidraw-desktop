use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// A file that was opened from disk. Contents are returned as a UTF-8 string;
/// Excalidraw's native format is JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenedFile {
    pub path: String,
    pub contents: String,
}

/// Read a file from disk by absolute path.
///
/// Used when the frontend already knows the path it wants — e.g. opening from the
/// "Recent Files" menu, restoring a previous session, or handling a double-click
/// from the OS.
#[tauri::command]
pub fn open_file(path: String) -> Result<OpenedFile, AppError> {
    read_file_to_opened(Path::new(&path))
}

/// Write `contents` to `path`, replacing any existing file.
///
/// Used by Cmd+S when the document already has a known path.
#[tauri::command]
pub fn save_file(path: String, contents: String) -> Result<(), AppError> {
    write_file(Path::new(&path), &contents)
}

fn read_file_to_opened(path: &Path) -> Result<OpenedFile, AppError> {
    let contents =
        fs::read_to_string(path).map_err(|e| AppError::io(path.display().to_string(), e))?;
    let canonical: PathBuf = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    Ok(OpenedFile {
        path: canonical.to_string_lossy().into_owned(),
        contents,
    })
}

fn write_file(path: &Path, contents: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::InvalidFile(format!(
                "parent directory does not exist: {}",
                parent.display()
            )));
        }
    }
    fs::write(path, contents).map_err(|e| AppError::io(path.display().to_string(), e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn open_file_roundtrips_utf8_contents() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("scene.excalidraw");
        let expected = r#"{"type":"excalidraw","version":2,"elements":[]}"#;
        fs::write(&path, expected).unwrap();

        let opened = open_file(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(opened.contents, expected);
        assert!(opened.path.ends_with("scene.excalidraw"));
    }

    #[test]
    fn save_file_writes_contents_to_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("scene.excalidraw");
        let payload = r#"{"type":"excalidraw","version":2,"elements":[{"id":"x"}]}"#;

        save_file(path.to_string_lossy().into_owned(), payload.to_string()).unwrap();

        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, payload);
    }

    #[test]
    fn save_file_overwrites_existing_contents() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("scene.excalidraw");
        fs::write(&path, "old").unwrap();

        save_file(path.to_string_lossy().into_owned(), "new".to_string()).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
    }

    #[test]
    fn open_file_missing_returns_io_error() {
        let err = open_file("/definitely/does/not/exist.excalidraw".into()).unwrap_err();
        match err {
            AppError::Io { path, .. } => assert!(path.contains("does/not/exist")),
            other => panic!("expected Io error, got {other:?}"),
        }
    }

    #[test]
    fn save_file_rejects_nonexistent_parent_directory() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope").join("scene.excalidraw");
        let err = save_file(path.to_string_lossy().into_owned(), "x".into()).unwrap_err();
        match err {
            AppError::InvalidFile(msg) => assert!(msg.contains("parent directory")),
            other => panic!("expected InvalidFile error, got {other:?}"),
        }
    }
}
