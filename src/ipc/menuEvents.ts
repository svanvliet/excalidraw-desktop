/**
 * Subscribe to native menu events forwarded from Rust.
 *
 * The Rust side (src-tauri/src/menu.rs) emits `excalidraw://menu` with the
 * menu item ID as payload. We mirror the IDs here as a strongly-typed
 * enum so missing handlers fail fast at compile time.
 *
 * Keep this list in sync with `menu::ids` in src-tauri/src/menu.rs. The
 * cargo test `ids_are_stable_and_namespaced` is the drift detector on the
 * Rust side; the `MENU_ITEM_IDS` array below is the drift detector here.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const MENU_EVENT = "excalidraw://menu";

export type MenuItemId =
  | "excalidraw:file:new"
  | "excalidraw:file:open"
  | "excalidraw:file:save"
  | "excalidraw:file:saveAs"
  | "excalidraw:file:exportPng"
  | "excalidraw:file:closeTab"
  | "excalidraw:edit:undo"
  | "excalidraw:edit:redo"
  | "excalidraw:view:zoomIn"
  | "excalidraw:view:zoomOut"
  | "excalidraw:view:zoomReset"
  | "excalidraw:help:about"
  | "excalidraw:help:docs";

export const MENU_ITEM_IDS: readonly MenuItemId[] = [
  "excalidraw:file:new",
  "excalidraw:file:open",
  "excalidraw:file:save",
  "excalidraw:file:saveAs",
  "excalidraw:file:exportPng",
  "excalidraw:file:closeTab",
  "excalidraw:edit:undo",
  "excalidraw:edit:redo",
  "excalidraw:view:zoomIn",
  "excalidraw:view:zoomOut",
  "excalidraw:view:zoomReset",
  "excalidraw:help:about",
  "excalidraw:help:docs",
] as const;

const VALID = new Set<string>(MENU_ITEM_IDS);

export function isMenuItemId(value: unknown): value is MenuItemId {
  return typeof value === "string" && VALID.has(value);
}

export async function onMenuEvent(handler: (id: MenuItemId) => void): Promise<UnlistenFn> {
  return listen<string>(MENU_EVENT, (event) => {
    if (isMenuItemId(event.payload)) handler(event.payload);
  });
}

/**
 * Dispatch a synthetic keyboard shortcut to the active document so
 * Excalidraw's internal key handlers (Undo, Redo, Zoom, etc.) fire.
 *
 * Excalidraw listens at the document level, so as long as the canvas is
 * mounted the event reaches it. We bubble so any focused inner element
 * sees it first.
 *
 * `key` is the platform-agnostic key name (e.g. "z", "=", "0").
 */
export function dispatchShortcut(opts: {
  key: string;
  shift?: boolean;
  /** Default true — uses Cmd on macOS and Ctrl elsewhere. */
  mod?: boolean;
  target?: Document | HTMLElement;
}): void {
  const target = opts.target ?? document;
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mod = opts.mod ?? true;
  const ev = new KeyboardEvent("keydown", {
    key: opts.key,
    code: keyToCode(opts.key),
    bubbles: true,
    cancelable: true,
    metaKey: mod && isMac,
    ctrlKey: mod && !isMac,
    shiftKey: opts.shift ?? false,
  });
  target.dispatchEvent(ev);
}

function keyToCode(key: string): string {
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= "A" && upper <= "Z") return `Key${upper}`;
    if (upper >= "0" && upper <= "9") return `Digit${upper}`;
    if (key === "=") return "Equal";
    if (key === "-") return "Minus";
  }
  return key;
}
