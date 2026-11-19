import { parseShareLink } from "../collab/link";
import type { RoomLink } from "../collab/protocol";

/** Mirrors `isTauri()` in `src/ipc/commands.ts` without importing Tauri modules. */
export function inTauri(win: Window = window): boolean {
  const w = win as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI_IPC__);
}

/**
 * Returns the room to join when this page should render guest mode
 * (collab-protocol §7): outside Tauri with a valid `#room=` fragment.
 */
export function guestLinkFor(href: string, isTauri: boolean): RoomLink | null {
  if (isTauri || !href.includes("#room=")) return null;
  return parseShareLink(href);
}
