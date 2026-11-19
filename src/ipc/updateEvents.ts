/**
 * Subscribe to `excalidraw://update-status` events emitted by
 * src-tauri/src/updater.rs. Mirrors the collabEvents.ts pattern.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { UPDATE_STATUS_EVENT, isTauri, type UpdateState } from "./commands";

export function isUpdateState(value: unknown): value is UpdateState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.status === "string" &&
    typeof v.currentVersion === "string" &&
    typeof v.enabled === "boolean"
  );
}

export async function onUpdateStatus(handler: (state: UpdateState) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>(UPDATE_STATUS_EVENT, (event) => {
    if (isUpdateState(event.payload)) handler(event.payload);
  });
}
