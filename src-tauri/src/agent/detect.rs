//! Binary discovery, version + login probing (core lane). See docs/ai-integration.md
//! "Process hygiene" and the T3 Code `DesktopShellEnvironment.ts` port notes.
use super::events::EngineKind;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineStatus {
    Ready,
    NotFound,
    NotLoggedIn,
    UnsupportedVersion,
    /// Login can't be probed offline (Copilot); verified on first session.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine: EngineKind,
    pub status: EngineStatus,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub min_version: String,
    pub message: Option<String>,
}
