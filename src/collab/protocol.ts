/**
 * Wire + payload types for live collaboration.
 * Contract: docs/collab-protocol.md — keep both in sync.
 */
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_PEERS_PER_ROOM = 32;
export const SESSION_ENDED_CLOSE_CODE = 4000;

// ----- relay frames (plaintext JSON) -----

export type ClientFrame =
  | { type: "join"; room: string; protocol: typeof PROTOCOL_VERSION }
  | { type: "broadcast"; volatile: boolean; iv: string; data: string };

export type RelayErrorCode = "unknown_room" | "room_full" | "bad_frame" | "too_large" | "protocol";

export type RelayFrame =
  | { type: "welcome"; clientId: string; peers: string[]; firstInRoom: boolean }
  | { type: "peers"; peers: string[] }
  | { type: "message"; from: string; volatile: boolean; iv: string; data: string }
  | { type: "error"; code: RelayErrorCode; message: string };

// ----- encrypted payloads -----

export type Payload =
  | { type: "HELLO"; username: string; isHost: boolean }
  | { type: "SYNC_REQUEST" }
  | { type: "SCENE_INIT"; elements: readonly OrderedExcalidrawElement[] }
  | { type: "SCENE_UPDATE"; elements: readonly OrderedExcalidrawElement[] }
  | {
      type: "MOUSE_LOCATION";
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "down" | "up";
      selectedElementIds: Record<string, true>;
      username: string;
    }
  | { type: "IDLE_STATUS"; userState: "active" | "idle" | "away"; username: string }
  | { type: "FILES"; files: BinaryFileData[] }
  | { type: "FILES_REQUEST"; ids: string[] };

/** Parsed share link: `<publicBase>/#room=<roomId>,<key>`. */
export interface RoomLink {
  publicBase: string;
  roomId: string;
  key: string;
}
