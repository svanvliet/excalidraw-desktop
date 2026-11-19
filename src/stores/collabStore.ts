/**
 * Live-collaboration session state (docs/collab-protocol.md).
 *
 * - `status` mirrors the Rust relay's `CollabStatus` (pushed via the
 *   `collab://status` event, seeded from `collab_status`).
 * - `session` is the single active session descriptor — either this app
 *   hosting a tab, or this app joined to someone else's link as a guest.
 *
 * The sync engine itself (`useCollabSession`, src/collab/) reads `session`
 * to know which tab to bind and which room/key to use. Nothing here opens
 * a socket; the network side-effects are `collab_start` (local relay +
 * optional tunnel) and whatever the hook does with the descriptor.
 */
import { create } from "zustand";
import {
  COLLAB_STATUS_OFF,
  collabStart,
  collabStatus,
  collabStop,
  isAppError,
  type CollabStatus,
} from "../ipc/commands";
import { onCollabStatus } from "../ipc/collabEvents";
import {
  buildShareLink as buildLink,
  generateRoomId,
  parseShareLink as parseLink,
} from "../collab/link";
import { generateKey } from "../collab/crypto";
import type { RoomLink } from "../collab/protocol";
import { log } from "../lib/logger";
import { useSettingsStore } from "./settingsStore";

export type CollabRole = "host" | "guest";

export interface CollabSessionDescriptor {
  role: CollabRole;
  tabId: string;
  roomId: string;
  key: string;
  /**
   * Base URL peers use to reach the room. For the host this is filled in
   * from `status.publicBase` once the relay/tunnel reports it (null while
   * the tunnel is starting). For a guest it comes from the pasted link.
   */
  publicBase: string | null;
}

export interface CollabState {
  status: CollabStatus;
  session: CollabSessionDescriptor | null;
  /** True while `collab_start` is in flight. */
  starting: boolean;
  /** Last user-facing error from start/stop/join. */
  error: string | null;
  /** Subscribe to relay status events + fetch the current status. Idempotent. */
  init: () => Promise<void>;
  startHosting: (tabId: string) => Promise<void>;
  stopHosting: () => Promise<void>;
  /** Bind `tabId` to a pasted share link as a guest. Returns false if the link is invalid. */
  joinSession: (link: string | RoomLink, tabId: string) => boolean;
  /** Leave a guest session (no IPC; the hook closes its socket). */
  leaveSession: () => void;
  /** End whatever session is bound to `tabId` (host → collab_stop). */
  endSessionForTab: (tabId: string) => Promise<void>;
  clearError: () => void;
}

// ---------------------------------------------------------------------------
// Link helpers — thin wrappers over src/collab/link.ts (§2 contract).
// ---------------------------------------------------------------------------

export function buildShareLink(link: RoomLink): string {
  return buildLink(link.publicBase, link.roomId, link.key);
}

/**
 * Parse a pasted `<publicBase>/#room=<roomId>,<key>` link. Stricter than
 * the guest-side parser: the desktop app has no implicit origin, so a full
 * http(s) URL is required.
 */
export function parseShareLink(input: string): RoomLink | null {
  const parsed = parseLink(input);
  if (!parsed || !/^https?:\/\/[^/]/i.test(parsed.publicBase)) return null;
  return parsed;
}

// ---------------------------------------------------------------------------

function formatError(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

let unlistenStatus: (() => void) | null = null;
let initPromise: Promise<void> | null = null;

function applyStatus(next: CollabStatus): void {
  const { session, status: prev } = useCollabStore.getState();
  let nextSession = session;
  if (session?.role === "host") {
    if (prev.running && !next.running) {
      // Relay went away underneath us (stopped elsewhere / crashed).
      nextSession = null;
    } else if (next.publicBase !== session.publicBase && next.roomId === session.roomId) {
      nextSession = { ...session, publicBase: next.publicBase };
    }
  }
  useCollabStore.setState({ status: next, session: nextSession });
}

export const useCollabStore = create<CollabState>((set, get) => ({
  status: COLLAB_STATUS_OFF,
  session: null,
  starting: false,
  error: null,

  init() {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          unlistenStatus = await onCollabStatus(applyStatus);
        } catch (e) {
          log.warn("collabStore: status subscription unavailable", e);
        }
        try {
          applyStatus(await collabStatus());
        } catch (e) {
          log.warn("collabStore: collab_status failed", e);
        }
      })();
    }
    return initPromise;
  },

  async startHosting(tabId) {
    const { session, starting } = get();
    if (starting) return;
    if (session) {
      set({ error: "A live session is already active. Stop it before starting another." });
      return;
    }
    const settings = useSettingsStore.getState();
    if (!settings.collab) {
      set({ error: "Live collaboration is turned off in Settings." });
      return;
    }
    const roomId = generateRoomId();
    const key = await generateKey();
    if (get().session || get().starting) return;
    set({
      starting: true,
      error: null,
      session: { role: "host", tabId, roomId, key, publicBase: null },
    });
    try {
      const status = await collabStart({
        roomId,
        port: settings.collabPort,
        tunnel: settings.collabTunnelMode,
        ...(settings.collabTunnelMode === "manual" && settings.collabManualUrl
          ? { manualUrl: settings.collabManualUrl }
          : {}),
      });
      log.info(`collab: hosting room on tab ${tabId} (tunnel=${settings.collabTunnelMode})`);
      set({ starting: false });
      applyStatus(status);
    } catch (e) {
      log.warn("collab: collab_start failed", e);
      set({ starting: false, session: null, error: formatError(e) });
    }
  },

  async stopHosting() {
    const { session } = get();
    set({ session: session?.role === "host" ? null : session, error: null });
    try {
      const status = await collabStop();
      useCollabStore.setState({ status });
      log.info("collab: session stopped");
    } catch (e) {
      log.warn("collab: collab_stop failed", e);
      set({ error: formatError(e) });
    }
  },

  joinSession(link, tabId) {
    const parsed = typeof link === "string" ? parseShareLink(link) : link;
    if (!parsed) {
      set({ error: "That doesn't look like a valid session link." });
      return false;
    }
    if (get().session) {
      set({ error: "A live session is already active. Leave it before joining another." });
      return false;
    }
    set({
      error: null,
      session: {
        role: "guest",
        tabId,
        roomId: parsed.roomId,
        key: parsed.key,
        publicBase: parsed.publicBase,
      },
    });
    log.info(`collab: joined session as guest on tab ${tabId}`);
    return true;
  },

  leaveSession() {
    if (get().session?.role === "guest") set({ session: null });
  },

  async endSessionForTab(tabId) {
    const { session } = get();
    if (!session || session.tabId !== tabId) return;
    if (session.role === "host") await get().stopHosting();
    else get().leaveSession();
  },

  clearError() {
    set({ error: null });
  },
}));

/** Share link for the active host session, once a public base is known. */
export function selectShareLink(s: CollabState): string | null {
  const { session } = s;
  if (!session?.publicBase) return null;
  return buildShareLink({
    publicBase: session.publicBase,
    roomId: session.roomId,
    key: session.key,
  });
}

/** Local-only link (`http://127.0.0.1:<port>`) for the active host session. */
export function selectLocalLink(s: CollabState): string | null {
  const { session, status } = s;
  if (session?.role !== "host" || !status.localBase) return null;
  return buildShareLink({ publicBase: status.localBase, roomId: session.roomId, key: session.key });
}

/** Exported for tests. */
export function __resetCollabStoreForTests(): void {
  unlistenStatus?.();
  unlistenStatus = null;
  initPromise = null;
  useCollabStore.setState({
    status: COLLAB_STATUS_OFF,
    session: null,
    starting: false,
    error: null,
  });
}
