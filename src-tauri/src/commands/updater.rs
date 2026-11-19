//! Update commands. The frontend owns scheduling and consent; see
//! `crate::updater` for the state machine.

use tauri::AppHandle;

use crate::error::AppError;
use crate::updater::{self, UpdateState};

#[tauri::command]
pub fn update_status(app: AppHandle) -> Result<UpdateState, AppError> {
    Ok(updater::snapshot(&app))
}

/// Check for (and download) an update. `manual` surfaces errors to the UI.
#[tauri::command]
pub async fn update_check(app: AppHandle, manual: bool) -> Result<UpdateState, AppError> {
    updater::check(&app, manual).await;
    Ok(updater::snapshot(&app))
}

/// Install the downloaded update and restart.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), AppError> {
    updater::install(&app).await.map_err(AppError::Other)
}
