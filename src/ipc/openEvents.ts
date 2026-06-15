/**
 * Subscribe to OS-driven "open this file" events forwarded from Rust.
 *
 * Source events:
 * - macOS: RunEvent::Opened (Finder "Open With" or double-click on a
 *   .excalidraw / .png file when the app is running, plus the path passed
 *   at first launch).
 * - Windows/Linux: argv at first launch + tauri-plugin-single-instance
 *   handler for subsequent invocations.
 *
 * Returns an unsubscribe function.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export const FILE_OPEN_EVENT = "excalidraw://file-open";

export async function onFileOpenRequest(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>(FILE_OPEN_EVENT, (event) => {
    if (typeof event.payload === "string") handler(event.payload);
  });
}

/**
 * Subscribe to drag-drop events on the current window.
 *
 * `handler` is called once per dropped path. Tauri's webview emits one
 * event with N paths; we flatten so the caller doesn't have to.
 */
export async function onWindowFileDrop(handler: (path: string) => void): Promise<UnlistenFn> {
  const webview = getCurrentWebview();
  return webview.onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    for (const p of event.payload.paths) handler(p);
  });
}
