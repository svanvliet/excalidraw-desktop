//! OS-integration commands: queued file-open requests, the native
//! File → Open Recent submenu, and the signed-in user's name.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::error::AppError;
use crate::menu::ids;

/// Event name shared with the frontend (`src/ipc/openEvents.ts`).
pub const FILE_OPEN_EVENT: &str = "excalidraw://file-open";

/// Holds file-open requests that arrive before the webview is listening.
/// On a cold launch from Finder, macOS delivers `RunEvent::Opened` before
/// `setup` even runs, so an immediate `emit` would be dropped.
#[derive(Default)]
pub struct OpenQueue(Mutex<OpenQueueInner>);

#[derive(Default)]
struct OpenQueueInner {
    ready: bool,
    pending: Vec<String>,
}

impl OpenQueue {
    /// Queue `path` if the frontend isn't ready; returns it back otherwise.
    fn offer(&self, path: String) -> Option<String> {
        let mut q = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if q.ready {
            Some(path)
        } else {
            q.pending.push(path);
            None
        }
    }

    fn mark_ready(&self) -> Vec<String> {
        let mut q = self.0.lock().unwrap_or_else(|e| e.into_inner());
        q.ready = true;
        std::mem::take(&mut q.pending)
    }
}

/// Route an OS-provided file path to the frontend, queueing it until the
/// frontend has subscribed.
pub fn dispatch_file_open<R: Runtime>(app: &AppHandle<R>, path: String) {
    let ready = match app.try_state::<OpenQueue>() {
        Some(q) => q.offer(path),
        None => Some(path),
    };
    match ready {
        Some(path) => {
            let _ = app.emit(FILE_OPEN_EVENT, path);
        }
        None => log::info!("file-open queued until the frontend is ready"),
    }
}

/// Called once the frontend listens for file-open events. Returns (and
/// clears) whatever arrived before that.
#[tauri::command]
pub fn file_open_ready(queue: State<'_, OpenQueue>) -> Vec<String> {
    let pending = queue.mark_ready();
    log::info!("file_open_ready: draining {} queued path(s)", pending.len());
    pending
}

/// Paths behind the Open Recent items, indexed by their menu id suffix.
#[derive(Default)]
pub struct RecentMenuState(Mutex<Vec<String>>);

impl RecentMenuState {
    pub fn path_for(&self, menu_id: &str) -> Option<String> {
        let idx: usize = menu_id
            .strip_prefix(ids::RECENT_ITEM_PREFIX)?
            .parse()
            .ok()?;
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(idx)
            .cloned()
    }
}

#[derive(Debug, Deserialize)]
pub struct RecentMenuItem {
    pub path: String,
    pub label: String,
}

/// Rebuild File → Open Recent from the frontend's recent-files list.
#[tauri::command]
pub fn set_recent_menu<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RecentMenuState>,
    items: Vec<RecentMenuItem>,
) -> Result<(), AppError> {
    let err = |e: tauri::Error| AppError::Other(format!("recent menu: {e}"));
    let Some(submenu) = app
        .menu()
        .and_then(|m| m.get(ids::FILE_MENU))
        .and_then(|k| k.as_submenu().cloned())
        .and_then(|file| file.get(ids::RECENT_MENU))
        .and_then(|k| k.as_submenu().cloned())
    else {
        return Ok(());
    };
    for item in submenu.items().map_err(err)? {
        submenu.remove(&item).map_err(err)?;
    }
    let mut new_items: Vec<MenuItemKind<R>> = Vec::new();
    if items.is_empty() {
        let none = MenuItem::new(&app, "No Recent Files", false, None::<&str>).map_err(err)?;
        new_items.push(MenuItemKind::MenuItem(none));
    } else {
        for (i, it) in items.iter().enumerate() {
            let id = format!("{}{i}", ids::RECENT_ITEM_PREFIX);
            let label = menu_label(&it.label);
            let item = MenuItem::with_id(&app, id, label, true, None::<&str>).map_err(err)?;
            new_items.push(MenuItemKind::MenuItem(item));
        }
        let sep = PredefinedMenuItem::separator(&app).map_err(err)?;
        new_items.push(MenuItemKind::Predefined(sep));
        let clear = MenuItem::with_id(
            &app,
            ids::FILE_CLEAR_RECENT,
            "Clear Menu",
            true,
            None::<&str>,
        )
        .map_err(err)?;
        new_items.push(MenuItemKind::MenuItem(clear));
    }
    for item in &new_items {
        submenu.append(item).map_err(err)?;
    }
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) =
        items.into_iter().map(|it| it.path).collect();
    Ok(())
}

/// `&` marks a mnemonic in Windows menus; double it to show it literally.
fn menu_label(label: &str) -> String {
    if cfg!(target_os = "windows") {
        label.replace('&', "&&")
    } else {
        label.to_string()
    }
}

/// The user's display name as the OS knows it (full name when set, else the
/// login name). Empty when neither is available.
#[tauri::command]
pub fn os_user_name() -> String {
    pick_user_name(&whoami::realname(), &whoami::username())
}

fn pick_user_name(real: &str, login: &str) -> String {
    let real = real.trim();
    let name = if real.is_empty() || real.eq_ignore_ascii_case("unknown") {
        login.trim()
    } else {
        real
    };
    name.chars().take(64).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_holds_paths_until_ready_then_passes_through() {
        let q = OpenQueue::default();
        assert_eq!(q.offer("/a.excalidraw".into()), None);
        assert_eq!(q.offer("/b.png".into()), None);
        assert_eq!(q.mark_ready(), vec!["/a.excalidraw", "/b.png"]);
        assert_eq!(
            q.offer("/c.excalidraw".into()),
            Some("/c.excalidraw".into())
        );
        assert!(q.mark_ready().is_empty());
    }

    #[test]
    fn recent_path_lookup_by_menu_id() {
        let s = RecentMenuState::default();
        *s.0.lock().unwrap() = vec!["/x.excalidraw".into(), "/y.excalidraw".into()];
        assert_eq!(
            s.path_for(&format!("{}1", ids::RECENT_ITEM_PREFIX))
                .as_deref(),
            Some("/y.excalidraw")
        );
        assert_eq!(s.path_for(&format!("{}9", ids::RECENT_ITEM_PREFIX)), None);
        assert_eq!(s.path_for(ids::FILE_OPEN), None);
    }

    #[test]
    fn user_name_prefers_real_name_and_falls_back_to_login() {
        assert_eq!(pick_user_name("Ada Lovelace", "ada"), "Ada Lovelace");
        assert_eq!(pick_user_name("  ", "ada"), "ada");
        assert_eq!(pick_user_name("Unknown", "ada"), "ada");
        assert_eq!(pick_user_name("", ""), "");
    }
}
