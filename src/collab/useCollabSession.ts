/**
 * React binding for {@link CollabSession}. Owns the session lifecycle for a
 * given Excalidraw API + room link and exposes stable handlers to spread onto
 * `<Excalidraw>`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import {
  CollabSession,
  type CollabApi,
  type CollabPeer,
  type CollabStatus,
  type CollabTiming,
  type EditRequestState,
  type PointerUpdatePayload,
} from "./CollabSession";
import { wsUrlFor } from "./link";
import type { RelayErrorCode, Role, RoomLink } from "./protocol";
import { WebSocketTransport, type RelayTransport } from "./transport";

export interface UseCollabSessionOptions {
  /** Excalidraw imperative API; the session starts once this is non-null. */
  api: CollabApi | null;
  /** Room to join; `null` keeps collaboration off. */
  link: RoomLink | null;
  username: string;
  isHost: boolean;
  /** Host webview only: `CollabStatus.hostToken`, so the relay grants the host role. */
  hostToken?: string | null;
  /** Fired after a remote edit was applied (never for local edits). */
  onRemoteChange?: () => void;
  /** Override the transport (tests). Defaults to a WebSocket to `wsUrlFor(link.publicBase)`. */
  createTransport?: (link: RoomLink, creds: TransportCredentials) => RelayTransport;
  timing?: Partial<CollabTiming>;
}

export interface CollabHandlers {
  onChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void;
  onPointerUpdate: (payload: PointerUpdatePayload) => void;
}

export interface TransportCredentials {
  hostToken: string | null;
  resumeToken: string | null;
}

export interface UseCollabSessionResult {
  status: CollabStatus;
  error: { code: RelayErrorCode; message: string } | null;
  peers: CollabPeer[];
  /** Our relay-assigned role; viewers must render the canvas read-only. */
  role: Role;
  editRequest: EditRequestState;
  requestEdit: () => void;
  denyEdit: (clientId: string) => void;
  handlers: CollabHandlers;
  session: CollabSession | null;
}

const defaultTransport = (link: RoomLink, creds: TransportCredentials): RelayTransport =>
  new WebSocketTransport(wsUrlFor(link.publicBase), creds);

/** Guests keep their role across page reloads via a per-room resume token. */
const resumeKey = (roomId: string) => `excalidraw-collab-resume:${roomId}`;
function loadResume(roomId: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(resumeKey(roomId)) ?? null;
  } catch {
    return null;
  }
}
function saveResume(roomId: string, token: string | null): void {
  try {
    if (token) globalThis.sessionStorage?.setItem(resumeKey(roomId), token);
  } catch {
    // Storage unavailable (private mode); the role just won't survive a reload.
  }
}

export function useCollabSession({
  api,
  link,
  username,
  isHost,
  hostToken = null,
  onRemoteChange,
  createTransport,
  timing,
}: UseCollabSessionOptions): UseCollabSessionResult {
  const [role, setRole] = useState<Role>(isHost ? "host" : "viewer");
  const [editRequest, setEditRequest] = useState<EditRequestState>("none");
  const [status, setStatus] = useState<CollabStatus>("idle");
  const [error, setError] = useState<UseCollabSessionResult["error"]>(null);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [session, setSession] = useState<CollabSession | null>(null);
  const sessionRef = useRef<CollabSession | null>(null);

  // Values read once at session start or via callbacks; changing them must not restart.
  const latest = useRef({ username, onRemoteChange, createTransport, timing });
  latest.current = { username, onRemoteChange, createTransport, timing };

  const roomId = link?.roomId ?? null;
  const key = link?.key ?? null;
  const publicBase = link?.publicBase ?? null;

  useEffect(() => {
    if (!api || roomId === null || key === null || publicBase === null) return;
    const roomLink: RoomLink = { roomId, key, publicBase };
    const transport = (latest.current.createTransport ?? defaultTransport)(roomLink, {
      hostToken,
      resumeToken: hostToken ? null : loadResume(roomId),
    });
    setRole(isHost ? "host" : "viewer");
    setEditRequest("none");
    const s = new CollabSession({
      transport,
      roomId,
      key,
      username: latest.current.username,
      isHost,
      api,
      timing: latest.current.timing,
      onStatus: (next, err) => {
        setStatus(next);
        setError(err ?? null);
      },
      onPeersChange: setPeers,
      onRemoteChange: () => latest.current.onRemoteChange?.(),
      onRoleChange: (r) => {
        setRole(r);
        if (!hostToken && "currentResumeToken" in transport) {
          saveResume(
            roomId,
            (transport as { currentResumeToken: string | null }).currentResumeToken,
          );
        }
      },
      onEditRequestStateChange: setEditRequest,
    });
    sessionRef.current = s;
    setSession(s);
    s.start();
    return () => {
      sessionRef.current = null;
      setSession(null);
      setPeers([]);
      setStatus("idle");
      setError(null);
      void s.stop();
    };
  }, [api, roomId, key, publicBase, isHost, hostToken]);

  useEffect(() => {
    sessionRef.current?.setUsername(username);
  }, [username]);

  const onChange = useCallback<CollabHandlers["onChange"]>(
    (elements, appState, files) => sessionRef.current?.onSceneChange(elements, appState, files),
    [],
  );
  const onPointerUpdate = useCallback<CollabHandlers["onPointerUpdate"]>(
    (payload) => sessionRef.current?.onPointerUpdate(payload),
    [],
  );
  const handlers = useMemo(() => ({ onChange, onPointerUpdate }), [onChange, onPointerUpdate]);
  const requestEdit = useCallback(() => sessionRef.current?.requestEdit(), []);
  const denyEdit = useCallback((id: string) => sessionRef.current?.denyEdit(id), []);

  return { status, error, peers, role, editRequest, requestEdit, denyEdit, handlers, session };
}
