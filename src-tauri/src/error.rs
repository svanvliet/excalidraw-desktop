use serde::Serialize;
use thiserror::Error;

/// Application-wide error type. All public Tauri commands return `Result<T, AppError>`
/// so the frontend gets a consistently shaped error.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("io error at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("invalid file: {0}")]
    InvalidFile(String),

    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub fn io(path: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

/// Wire shape sent to the frontend: a tagged kind + a human-readable message.
/// Keeping this stable lets the TS layer pattern-match without parsing strings.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SerializedAppError {
    Io { path: String, message: String },
    InvalidFile { message: String },
    Other { message: String },
}

impl From<&AppError> for SerializedAppError {
    fn from(err: &AppError) -> Self {
        match err {
            AppError::Io { path, source } => Self::Io {
                path: path.clone(),
                message: source.to_string(),
            },
            AppError::InvalidFile(msg) => Self::InvalidFile {
                message: msg.clone(),
            },
            AppError::Other(msg) => Self::Other {
                message: msg.clone(),
            },
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        SerializedAppError::from(self).serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_io_error_with_path_and_message() {
        let err = AppError::io(
            "/tmp/missing.excalidraw",
            std::io::Error::new(std::io::ErrorKind::NotFound, "no such file"),
        );
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "io");
        assert_eq!(json["path"], "/tmp/missing.excalidraw");
        assert!(json["message"].as_str().unwrap().contains("no such file"));
    }

    #[test]
    fn serializes_invalid_file_error() {
        let err = AppError::InvalidFile("not excalidraw json".into());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "invalid_file");
        assert_eq!(json["message"], "not excalidraw json");
    }
}
