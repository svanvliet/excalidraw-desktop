//! Tauri commands for live collaboration (docs/collab-protocol.md §5).

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Runtime, State};

use crate::collab::manager::{CollabManager, CollabStartArgs, CollabStatus, EmitFn};
use crate::collab::relay::{Asset, AssetSource};
use crate::error::AppError;

pub const COLLAB_STATUS_EVENT: &str = "collab://status";

/// Active test profile (`--profile` / `EXCALIDRAW_DESKTOP_PROFILE`).
pub struct AppProfile(pub Option<String>);

/// Serves the app's own frontend bundle to browser guests. Release builds
/// read embedded assets; dev builds (with `devUrl`) read `frontendDist`
/// (`../dist`) from disk, so run `npm run build` before testing guests.
struct TauriAssets<R: Runtime>(AppHandle<R>);

impl<R: Runtime> AssetSource for TauriAssets<R> {
    fn get(&self, path: &str) -> Option<Asset> {
        self.0
            .asset_resolver()
            .get(format!("/{path}"))
            .map(|a| Asset {
                bytes: a.bytes,
                mime: a.mime_type,
            })
    }
}

pub fn create_manager<R: Runtime>(app: &AppHandle<R>, profile: Option<&str>) -> Arc<CollabManager> {
    let emitter = app.clone();
    let emit: EmitFn = Arc::new(move |status: &CollabStatus| {
        if let Err(e) = emitter.emit(COLLAB_STATUS_EVENT, status) {
            log::warn!("collab: emit status failed: {e}");
        }
    });
    let assets: Arc<dyn AssetSource> = Arc::new(TauriAssets(app.clone()));
    Arc::new(CollabManager::new(emit, Some(assets), profile))
}

#[tauri::command]
pub async fn collab_start(
    manager: State<'_, Arc<CollabManager>>,
    args: CollabStartArgs,
) -> Result<CollabStatus, AppError> {
    log::info!(
        "collab_start: room={} port={} tunnel={:?}",
        args.room_id,
        args.port,
        args.tunnel
    );
    manager.start(args).await.map_err(|e| {
        log::error!("collab_start failed: {e}");
        AppError::Other(e)
    })
}

#[tauri::command]
pub async fn collab_stop(manager: State<'_, Arc<CollabManager>>) -> Result<CollabStatus, AppError> {
    log::info!("collab_stop");
    Ok(manager.stop().await)
}

#[tauri::command]
pub async fn collab_remove_peer(
    manager: State<'_, Arc<CollabManager>>,
    client_id: String,
) -> Result<(), AppError> {
    log::info!("collab_remove_peer: {client_id}");
    manager
        .remove_peer(&client_id)
        .await
        .map_err(AppError::Other)
}

#[tauri::command]
pub fn collab_status(manager: State<'_, Arc<CollabManager>>) -> Result<CollabStatus, AppError> {
    Ok(manager.status())
}

#[tauri::command]
pub fn app_profile(profile: State<'_, AppProfile>) -> Result<Option<String>, AppError> {
    Ok(profile.0.clone())
}
