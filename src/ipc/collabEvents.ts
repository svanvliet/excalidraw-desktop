/**
 * Subscribe to `collab://status` events emitted by the Rust relay
 * (docs/collab-protocol.md §5). Mirrors the menuEvents.ts pattern.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { COLLAB_STATUS_EVENT, isTauri, type CollabStatus } from "./commands";

export function isCollabStatus(value: unknown): value is CollabStatus {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const tunnel = v.tunnel as Record<string, unknown> | undefined;
  return (
    typeof v.running === "boolean" &&
    typeof v.peerCount === "number" &&
    !!tunnel &&
    typeof tunnel === "object" &&
    typeof tunnel.state === "string"
  );
}

export async function onCollabStatus(handler: (status: CollabStatus) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>(COLLAB_STATUS_EVENT, (event) => {
    if (isCollabStatus(event.payload)) handler(event.payload);
  });
}
