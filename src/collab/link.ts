/**
 * Share-link helpers (docs/collab-protocol.md §2):
 *   `<publicBase>/#room=<roomId>,<key>`
 */
import { isValidKey } from "./crypto";
import type { RoomLink } from "./protocol";

const ROOM_ID_RE = /^[0-9a-f]{20}$/;

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_RE.test(roomId);
}

/** 20 lowercase hex chars (80 random bits). */
export function generateRoomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeBase(publicBase: string): string {
  return publicBase.replace(/\/+$/, "");
}

export function buildShareLink(publicBase: string, roomId: string, key: string): string {
  return `${normalizeBase(publicBase)}/#room=${roomId},${key}`;
}

/**
 * Parses a full share link or just its hash (`#room=…`). For a bare hash the
 * returned `publicBase` is `fallbackBase` (e.g. `location.origin`), or "" if
 * none was given. Returns null when the room id or key is malformed.
 */
export function parseShareLink(urlOrHash: string, fallbackBase = ""): RoomLink | null {
  const input = urlOrHash.trim();
  const hashIdx = input.indexOf("#");
  if (hashIdx < 0) return null;
  const match = /(?:^|[#&])room=([^,&]+),([^&]+)/.exec(input.slice(hashIdx));
  if (!match) return null;
  const [, roomId, key] = match;
  if (!isValidRoomId(roomId) || !isValidKey(key)) return null;

  let publicBase = normalizeBase(fallbackBase);
  if (hashIdx > 0) {
    try {
      const url = new URL(input.slice(0, hashIdx));
      publicBase = normalizeBase(`${url.origin}${url.pathname}`);
    } catch {
      return null;
    }
  }
  return { publicBase, roomId, key };
}

/** `http→ws`, `https→wss`, plus `/ws`. */
export function wsUrlFor(publicBase: string): string {
  const base = normalizeBase(publicBase);
  if (/^https:\/\//i.test(base)) return `wss://${base.slice(8)}/ws`;
  if (/^http:\/\//i.test(base)) return `ws://${base.slice(7)}/ws`;
  throw new Error(`wsUrlFor: unsupported publicBase "${publicBase}"`);
}
