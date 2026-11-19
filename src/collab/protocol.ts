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
export const REMOVED_CLOSE_CODE = 4001;

// ----- relay frames (plaintext JSON) -----

/** Relay-assigned participant role (§3 "Roles"). Only host/editor may change the scene. */
export type Role = "host" | "editor" | "viewer";
export type RolesMap = Record<string, Role>;

export type ClientFrame =
  | {
      type: "join";
      room: string;
      protocol: typeof PROTOCOL_VERSION;
      /** Host webview only: secret from `collab_start` status. */
      hostToken?: string;
      /** `resumeToken` from a previous welcome; restores the role on reconnect. */
      resume?: string;
    }
  | { type: "broadcast"; volatile: boolean; iv: string; data: string };

export type RelayErrorCode = "unknown_room" | "room_full" | "bad_frame" | "too_large" | "protocol";

export type RelayFrame =
  | {
      type: "welcome";
      clientId: string;
      peers: string[];
      firstInRoom: boolean;
      roles: RolesMap;
      resumeToken: string;
    }
  | { type: "peers"; peers: string[]; roles: RolesMap }
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
  | { type: "FILES_REQUEST"; ids: string[] }
  /** A viewer asks the host for edit access. */
  | { type: "EDIT_REQUEST" }
  /** Host declined `clientId`'s EDIT_REQUEST (grants arrive as a role change). */
  | { type: "EDIT_DENIED"; clientId: string };

/** Parsed share link: `<publicBase>/#room=<roomId>,<key>`. */
export interface RoomLink {
  publicBase: string;
  roomId: string;
  key: string;
}
