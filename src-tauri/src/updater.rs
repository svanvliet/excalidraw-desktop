//! Self-update from GitHub Releases (modeled on tunnel-bar's updater).
//!
//! Rust never checks on its own: the frontend's `updateStore` decides
//! when to call `update_check`, so the user's `autoUpdate` consent lives
//! in one place. A check downloads and signature-verifies the update in
//! the background; installing only happens when the user clicks
//! "Restart to update".
//!
//! The update request is made natively (reqwest), not from the webview,
//! so it isn't subject to the CSP and sends no diagram data.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Frontend mirror: `UPDATE_STATUS_EVENT` in `src/ipc/commands.ts`.
pub const UPDATE_STATUS_EVENT: &str = "excalidraw://update-status";

/// Build-time endpoint override for local update tests. The release
/// script refuses to build with it set (unless `ALLOW_TEST_BUILD=1`).
const ENDPOINT_OVERRIDE: Option<&str> = option_env!("EXCALIDRAW_UPDATE_ENDPOINT");

/// `tauri dev` builds aren't installed bundles, so they never update
/// unless pointed at a test endpoint.
pub fn enabled() -> bool {
    !cfg!(debug_assertions) || ENDPOINT_OVERRIDE.is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: UpdateStatus,
    pub current_version: String,
    /// Version of the available/downloaded update.
    pub version: Option<String>,
    pub notes: Option<String>,
    /// 0..=1 while downloading, when the size is known.
    pub progress: Option<f64>,
    pub error: Option<String>,
    /// RFC 3339 timestamp of the last completed check.
    pub last_checked: Option<String>,
    /// False in dev builds.
    pub enabled: bool,
}

#[derive(Default)]
pub struct Updates {
    state: Mutex<UpdateState>,
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    busy: tokio::sync::Mutex<()>,
}

impl Updates {
    pub fn view(&self, current_version: &str) -> UpdateState {
        let mut s = self.state.lock().unwrap().clone();
        s.current_version = current_version.to_string();
        s.enabled = enabled();
        s
    }

    fn set(&self, f: impl FnOnce(&mut UpdateState)) {
        f(&mut self.state.lock().unwrap());
    }

    fn status(&self) -> UpdateStatus {
        self.state.lock().unwrap().status
    }
}

fn current_version<R: Runtime>(app: &AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

pub fn snapshot<R: Runtime>(app: &AppHandle<R>) -> UpdateState {
    app.state::<Updates>().view(&current_version(app))
}

fn publish<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(UPDATE_STATUS_EVENT, snapshot(app));
}

fn now_rfc3339() -> String {
    // Avoids a chrono dependency; the frontend only displays this.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_rfc3339(secs)
}

/// Format UNIX seconds as `YYYY-MM-DDTHH:MM:SSZ` (civil-from-days).
fn format_rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn updater<R: Runtime>(app: &AppHandle<R>) -> Result<tauri_plugin_updater::Updater, String> {
    let mut b = app.updater_builder().timeout(Duration::from_secs(60));
    if let Some(url) = ENDPOINT_OVERRIDE {
        let url = url
            .parse()
            .map_err(|e| format!("bad update endpoint: {e}"))?;
        b = b.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    b.build().map_err(|e| e.to_string())
}

/// Turns transport errors into something readable; the full error is logged.
pub fn friendly_error(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("error sending request")
        || l.contains("dns")
        || l.contains("connect")
        || l.contains("timed out")
    {
        "Couldn’t reach the update server. Check your internet connection.".into()
    } else if l.contains("signature") {
        "The downloaded update failed signature verification and was discarded.".into()
    } else if l.contains("valid release json") {
        "No update information was found for the latest release.".into()
    } else {
        e.to_string()
    }
}

/// Check for an update and, if one exists, download + verify it. Background
/// (`manual = false`) failures are only logged; manual ones are surfaced.
pub async fn check<R: Runtime>(app: &AppHandle<R>, manual: bool) {
    let updates = app.state::<Updates>();
    if !enabled() {
        if manual {
            updates.set(|s| {
                s.status = UpdateStatus::Error;
                s.error = Some("Updates are disabled in development builds.".into());
            });
            publish(app);
        }
        return;
    }
    let Ok(_guard) = updates.busy.try_lock() else {
        return;
    };
    let before = updates.status();
    if matches!(before, UpdateStatus::Ready | UpdateStatus::Installing) {
        return;
    }
    updates.set(|s| {
        s.status = UpdateStatus::Checking;
        s.error = None;
    });
    publish(app);

    let fail = |e: String| {
        log::warn!("updater: check failed: {e}");
        updates.set(|s| {
            s.progress = None;
            if manual {
                s.status = UpdateStatus::Error;
                s.error = Some(friendly_error(&e));
            } else {
                s.status = if before == UpdateStatus::Error {
                    UpdateStatus::Idle
                } else {
                    before
                };
                s.version = None;
            }
        });
        publish(app);
    };

    let found = match updater(app) {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    let current = current_version(app);
    let update = match found {
        Ok(None) => {
            log::info!("updater: up to date ({current})");
            updates.set(|s| {
                s.status = UpdateStatus::UpToDate;
                s.version = None;
                s.notes = None;
                s.last_checked = Some(now_rfc3339());
            });
            publish(app);
            return;
        }
        Ok(Some(u)) => u,
        Err(e) => return fail(e),
    };

    log::info!(
        "updater: {} available (running {current}); downloading",
        update.version
    );
    updates.set(|s| {
        s.status = UpdateStatus::Downloading;
        s.version = Some(update.version.clone());
        s.notes = update.body.clone().filter(|n| !n.trim().is_empty());
        s.progress = Some(0.0);
        s.last_checked = Some(now_rfc3339());
    });
    publish(app);

    let mut received: u64 = 0;
    let mut published = Instant::now();
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    updates.set(|s| s.progress = Some((received as f64 / total as f64).min(1.0)));
                    if published.elapsed() > Duration::from_millis(500) {
                        published = Instant::now();
                        publish(app);
                    }
                }
            },
            || {},
        )
        .await;
    match bytes {
        Ok(bytes) => {
            log::info!(
                "updater: {} downloaded and verified; waiting for restart",
                update.version
            );
            *updates.ready.lock().unwrap() = Some((update, bytes));
            updates.set(|s| {
                s.status = UpdateStatus::Ready;
                s.progress = None;
            });
            publish(app);
        }
        Err(e) => fail(e.to_string()),
    }
}

/// Install the downloaded update and restart into it.
pub async fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let updates = app.state::<Updates>();
    let (update, bytes) = updates
        .ready
        .lock()
        .unwrap()
        .clone()
        .ok_or("No update is ready to install.")?;
    updates.set(|s| {
        s.status = UpdateStatus::Installing;
        s.error = None;
    });
    publish(app);
    log::info!("updater: installing {}", update.version);
    let r = tauri::async_runtime::spawn_blocking(move || {
        update.install(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    if let Err(e) = r {
        log::error!("updater: install failed: {e}");
        let msg = format!("Couldn’t install the update: {e}");
        updates.set(|s| {
            s.status = UpdateStatus::Ready;
            s.error = Some(msg.clone());
        });
        publish(app);
        return Err(msg);
    }
    // Runs RunEvent::Exit (which stops the collab relay/tunnel) before
    // relaunching the new bundle. On Windows the NSIS installer has
    // already taken over and the process exits during `install`.
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_errors() {
        assert!(friendly_error(
            "error sending request for url (https://example.invalid/latest.json)"
        )
        .contains("internet"));
        assert!(friendly_error("signature verification failed").contains("signature"));
        assert!(
            friendly_error("Could not fetch a valid release JSON from the remote")
                .contains("No update information")
        );
        assert_eq!(friendly_error("something else"), "something else");
    }

    #[test]
    fn view_reports_version_and_availability() {
        let u = Updates::default();
        let v = u.view("1.2.3");
        assert_eq!(v.current_version, "1.2.3");
        assert_eq!(v.status, UpdateStatus::Idle);
        assert_eq!(v.enabled, enabled());
    }

    #[test]
    fn dev_builds_are_disabled_without_override() {
        if ENDPOINT_OVERRIDE.is_none() {
            assert_eq!(enabled(), !cfg!(debug_assertions));
        }
    }

    #[test]
    fn state_serializes_camel_case() {
        let s = UpdateState {
            status: UpdateStatus::UpToDate,
            last_checked: Some("x".into()),
            ..Default::default()
        };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["status"], "upToDate");
        assert_eq!(json["lastChecked"], "x");
        assert!(json.get("currentVersion").is_some());
    }

    #[test]
    fn formats_rfc3339() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(format_rfc3339(1_795_118_400), "2026-11-19T20:00:00Z");
    }
}
