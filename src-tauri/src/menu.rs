//! Native menu bar and keyboard accelerators.
//!
//! Every custom menu item has a stable ID under the `excalidraw:` namespace.
//! When the user clicks a custom item (or fires its accelerator) we re-emit
//! the ID on the frontend event `excalidraw://menu`. App.tsx fans the event
//! out to the existing in-app handlers (open, save, export, undo, etc.).
//!
//! Predefined items (Cut/Copy/Paste/Select All/Quit/Minimize/etc.) are
//! handled by the OS directly, so there's nothing to dispatch for them.
//!
//! Edit shortcuts that target the Excalidraw canvas (Undo/Redo, Zoom)
//! arrive as custom items because Excalidraw's history is JS-side and
//! doesn't respond to the OS-level "undo:" responder action — the
//! frontend re-dispatches a synthetic keyboard event into the canvas.

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event name emitted to the frontend whenever a custom menu item fires.
pub const MENU_EVENT: &str = "excalidraw://menu";

// ---------- Menu item IDs ----------
//
// Frontend mirrors these in `src/ipc/menuEvents.ts`. Keep in sync.

pub mod ids {
    pub const FILE_NEW: &str = "excalidraw:file:new";
    pub const FILE_OPEN: &str = "excalidraw:file:open";
    pub const FILE_SAVE: &str = "excalidraw:file:save";
    pub const FILE_SAVE_AS: &str = "excalidraw:file:saveAs";
    pub const FILE_EXPORT_PNG: &str = "excalidraw:file:exportPng";
    pub const FILE_CLOSE_TAB: &str = "excalidraw:file:closeTab";
    pub const FILE_SETTINGS: &str = "excalidraw:file:settings";

    pub const EDIT_UNDO: &str = "excalidraw:edit:undo";
    pub const EDIT_REDO: &str = "excalidraw:edit:redo";

    pub const VIEW_ZOOM_IN: &str = "excalidraw:view:zoomIn";
    pub const VIEW_ZOOM_OUT: &str = "excalidraw:view:zoomOut";
    pub const VIEW_ZOOM_RESET: &str = "excalidraw:view:zoomReset";

    pub const HELP_ABOUT: &str = "excalidraw:help:about";
    pub const HELP_DOCS: &str = "excalidraw:help:docs";
}

/// Platform-aware accelerator string.
#[cfg(target_os = "macos")]
const CMD: &str = "Cmd";
#[cfg(not(target_os = "macos"))]
const CMD: &str = "Ctrl";

fn accel(s: &str) -> String {
    s.replace("$Mod", CMD)
}

/// Build the application menu.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let mut menu = MenuBuilder::new(app);

    // ---- macOS App menu (must be first, named after the app) ----
    #[cfg(target_os = "macos")]
    {
        let app_name = app
            .config()
            .product_name
            .clone()
            .unwrap_or_else(|| "Excalidraw".to_string());
        let app_menu = SubmenuBuilder::new(app, &app_name)
            .about(None)
            .separator()
            .item(&MenuItem::with_id(
                app,
                ids::FILE_SETTINGS,
                "Settings…",
                true,
                Some(&accel("$Mod+,")),
            )?)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }

    // ---- File ----
    let file = SubmenuBuilder::new(app, "&File")
        .item(&MenuItem::with_id(
            app,
            ids::FILE_NEW,
            "New",
            true,
            Some(&accel("$Mod+N")),
        )?)
        .item(&MenuItem::with_id(
            app,
            ids::FILE_OPEN,
            "Open…",
            true,
            Some(&accel("$Mod+O")),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            ids::FILE_SAVE,
            "Save",
            true,
            Some(&accel("$Mod+S")),
        )?)
        .item(&MenuItem::with_id(
            app,
            ids::FILE_SAVE_AS,
            "Save As…",
            true,
            Some(&accel("$Mod+Shift+S")),
        )?)
        .item(&MenuItem::with_id(
            app,
            ids::FILE_EXPORT_PNG,
            "Export PNG…",
            true,
            Some(&accel("$Mod+Shift+E")),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            ids::FILE_CLOSE_TAB,
            "Close Tab",
            true,
            Some(&accel("$Mod+W")),
        )?);

    // On non-macOS, the File menu owns Quit (macOS owns it in the App menu).
    #[cfg(not(target_os = "macos"))]
    let file = file
        .separator()
        .item(&MenuItem::with_id(
            app,
            ids::FILE_SETTINGS,
            "Settings…",
            true,
            Some(&accel("$Mod+,")),
        )?)
        .separator()
        .quit();

    menu = menu.item(&file.build()?);

    // ---- Edit ----
    // Cut/Copy/Paste/Select All are predefined so they delegate to the OS
    // (and for inputs, do the right thing). Undo/Redo are custom because
    // Excalidraw owns its own history stack.
    let edit = SubmenuBuilder::new(app, "&Edit")
        .item(&MenuItem::with_id(
            app,
            ids::EDIT_UNDO,
            "Undo",
            true,
            Some(&accel("$Mod+Z")),
        )?)
        .item(&MenuItem::with_id(
            app,
            ids::EDIT_REDO,
            "Redo",
            true,
            Some(&accel("$Mod+Shift+Z")),
        )?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    menu = menu.item(&edit);

    // ---- View ----
    let view = SubmenuBuilder::new(app, "&View")
        .item(&MenuItem::with_id(
            app,
            ids::VIEW_ZOOM_IN,
            "Zoom In",
            true,
            Some(&accel("$Mod+=")),
        )?)
        .item(&MenuItem::with_id(
            app,
            ids::VIEW_ZOOM_OUT,
            "Zoom Out",
            true,
            Some(&accel("$Mod+-")),
        )?)
        .item(&MenuItem::with_id(
            app,
            ids::VIEW_ZOOM_RESET,
            "Reset Zoom",
            true,
            Some(&accel("$Mod+0")),
        )?)
        .separator()
        .fullscreen()
        .build()?;
    menu = menu.item(&view);

    // ---- Window ----
    #[cfg(target_os = "macos")]
    let window = SubmenuBuilder::new(app, "&Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;
    #[cfg(not(target_os = "macos"))]
    let window = SubmenuBuilder::new(app, "&Window")
        .minimize()
        .maximize()
        .build()?;
    menu = menu.item(&window);

    // ---- Help ----
    let help = SubmenuBuilder::new(app, "&Help")
        .item(&MenuItem::with_id(
            app,
            ids::HELP_ABOUT,
            "About Excalidraw Desktop",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            ids::HELP_DOCS,
            "Documentation",
            true,
            None::<&str>,
        )?)
        .build()?;
    menu = menu.item(&help);

    menu.build()
}

/// Forward custom menu events to the frontend. Predefined items don't
/// generate ID-bearing events that we care about (their behavior is
/// handled natively).
pub fn forward_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if !id.starts_with("excalidraw:") {
        return;
    }
    // Best-effort focus the main window so subsequent shortcuts are
    // delivered to the right place.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
    let _ = app.emit(MENU_EVENT, id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerator_maps_dollar_mod_to_platform_modifier() {
        let a = accel("$Mod+S");
        #[cfg(target_os = "macos")]
        assert_eq!(a, "Cmd+S");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(a, "Ctrl+S");
    }

    #[test]
    fn ids_are_stable_and_namespaced() {
        // Drift detector: if a frontend handler stops working, an ID rename
        // here is the usual culprit. Failing this test forces a sync edit
        // of src/ipc/menuEvents.ts.
        assert_eq!(ids::FILE_NEW, "excalidraw:file:new");
        assert_eq!(ids::FILE_OPEN, "excalidraw:file:open");
        assert_eq!(ids::FILE_SAVE, "excalidraw:file:save");
        assert_eq!(ids::FILE_SAVE_AS, "excalidraw:file:saveAs");
        assert_eq!(ids::FILE_EXPORT_PNG, "excalidraw:file:exportPng");
        assert_eq!(ids::FILE_CLOSE_TAB, "excalidraw:file:closeTab");
        assert_eq!(ids::FILE_SETTINGS, "excalidraw:file:settings");
        assert_eq!(ids::EDIT_UNDO, "excalidraw:edit:undo");
        assert_eq!(ids::EDIT_REDO, "excalidraw:edit:redo");
        assert_eq!(ids::VIEW_ZOOM_IN, "excalidraw:view:zoomIn");
        assert_eq!(ids::VIEW_ZOOM_OUT, "excalidraw:view:zoomOut");
        assert_eq!(ids::VIEW_ZOOM_RESET, "excalidraw:view:zoomReset");
        assert_eq!(ids::HELP_ABOUT, "excalidraw:help:about");
        assert_eq!(ids::HELP_DOCS, "excalidraw:help:docs");
    }
}
