/**
 * Browser guest mode (collab-protocol §7). Rendered when the bundle runs
 * outside Tauri and the URL carries `#room=`. Must never touch Tauri IPC or
 * the persisted stores — everything here is in-memory or `localStorage`.
 */
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import "@excalidraw/excalidraw/index.css";
import "./GuestApp.css";
import type { CollabPeer, CollabSession, CollabStatus } from "../collab/CollabSession";
import type { RoomLink } from "../collab/protocol";
import { useCollabSession } from "../collab/useCollabSession";
import { CloseIcon, LiveIcon, UsersIcon } from "../components/icons";
import { ParticipantList } from "../components/ParticipantList";
import { ViewerBar } from "../components/RoleBar";
import type { Role } from "../collab/protocol";
import { log } from "../lib/logger";
import {
  componentsOnDuplicate,
  installComponents,
  registerComponentActions,
  remoteApi,
} from "../extensions/components";

export const GUEST_NAME_KEY = "excalidraw-desktop:guest-name";
export const E2E_FLAG_KEY = "excalidraw-desktop:e2e";
const MAX_NAME = 40;

declare global {
  interface Window {
    __guest?: { api: ExcalidrawImperativeAPI; session: CollabSession | null };
  }
}

function readStoredName(): string {
  try {
    return localStorage.getItem(GUEST_NAME_KEY)?.trim().slice(0, MAX_NAME) ?? "";
  } catch {
    return "";
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Guest has no persisted theme preference: follow the OS. */
function useSystemTheme(): "light" | "dark" {
  const [dark, setDark] = useState(() => window.matchMedia?.(DARK_QUERY).matches ?? false);
  useEffect(() => {
    const mql = window.matchMedia?.(DARK_QUERY);
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  const theme = dark ? "dark" : "light";
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return theme;
}

type BannerTone = "info" | "warn" | "error";
const BANNERS: Partial<Record<CollabStatus, { text: string; tone: BannerTone }>> = {
  connecting: { text: "Connecting to the session…", tone: "info" },
  reconnecting: { text: "Connection lost — reconnecting…", tone: "warn" },
  ended: { text: "The host ended this session.", tone: "error" },
  failed: { text: "Couldn't join this session.", tone: "error" },
  removed: { text: "The host removed you from this session.", tone: "error" },
};

export interface GuestAppProps {
  link: RoomLink;
}

export function GuestApp({ link }: GuestAppProps) {
  const theme = useSystemTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // Components sync runs here too, so a guest's master edits reach every peer's instances.
  const handleApi = useCallback((next: ExcalidrawImperativeAPI) => {
    installComponents(next);
    registerComponentActions(next);
    setApi(next);
  }, []);
  const [username, setUsername] = useState(readStoredName);
  const [promptOpen, setPromptOpen] = useState(() => username === "");
  const [panelOpen, setPanelOpen] = useState(false);
  const [left, setLeft] = useState(false);

  const { status, error, peers, role, editRequest, requestEdit, handlers, session } =
    useCollabSession({
      api: remoteApi(api),
      // Hold off joining until the guest has a name so peers never see a blank one.
      link: username && !left ? link : null,
      username,
      isHost: false,
    });

  useEffect(() => {
    log.info(`guest: status=${status}${error ? ` error=${error.code}` : ""}`);
  }, [status, error]);

  useEffect(() => {
    let enabled = false;
    try {
      enabled = localStorage.getItem(E2E_FLAG_KEY) === "1";
    } catch {
      // storage unavailable
    }
    if (enabled && api) window.__guest = { api, session };
  }, [api, session]);

  const saveName = useCallback((name: string) => {
    const clean = name.trim().slice(0, MAX_NAME) || "Guest";
    try {
      localStorage.setItem(GUEST_NAME_KEY, clean);
    } catch {
      // storage unavailable; keep the in-memory name
    }
    setUsername(clean);
    setPromptOpen(false);
  }, []);

  const leave = useCallback(() => {
    setPanelOpen(false);
    setLeft(true);
  }, []);

  // Left, ended or removed: wipe our copy. The session is already offline, so
  // nothing reaches the room.
  useEffect(() => {
    if (left || status === "removed" || status === "ended") api?.resetScene();
  }, [left, status, api]);

  const banner = BANNERS[status];
  const ended = status === "ended" || status === "failed" || status === "removed";
  const offline = ended || left;
  const participants = peers.length + 1;

  const renderTopRightUI = useCallback(
    () =>
      username ? (
        <button
          type="button"
          className={`sidebar-trigger guest-live${offline ? " guest-live--off" : ""}`}
          data-testid="guest-session-btn"
          title={offline ? "Not connected" : `${participants} in session`}
          onClick={() => setPanelOpen(true)}
        >
          <LiveIcon className="guest-live__icon" />
          <span>{offline ? "Offline" : "Live"}</span>
          {offline ? null : <span className="guest-live__count">{participants}</span>}
        </button>
      ) : null,
    [offline, participants, username],
  );

  const initialData = useMemo(() => ({ appState: { name: "Shared drawing" } }), []);

  return (
    <div className="guest-app">
      {left ? (
        <div className="guest-banner guest-banner--info" role="status">
          You left the session.{" "}
          <button type="button" className="guest-banner__action" onClick={() => setLeft(false)}>
            Rejoin
          </button>
        </div>
      ) : banner ? (
        <div className={`guest-banner guest-banner--${banner.tone}`} role="status">
          {status === "failed" && error?.message
            ? `${banner.text} (${error.message})`
            : banner.text}
        </div>
      ) : status === "connected" && role === "viewer" ? (
        <ViewerBar state={editRequest} onRequest={requestEdit} />
      ) : null}
      <div className="guest-app__canvas">
        <Excalidraw
          excalidrawAPI={handleApi}
          onDuplicate={componentsOnDuplicate}
          initialData={initialData}
          onChange={handlers.onChange}
          onPointerUpdate={handlers.onPointerUpdate}
          isCollaborating={!offline}
          viewModeEnabled={offline || role === "viewer"}
          theme={theme}
          renderTopRightUI={renderTopRightUI}
        />
      </div>
      {promptOpen && (
        <NamePrompt initial={username} onSubmit={saveName} onCancel={() => saveName(username)} />
      )}
      {panelOpen && (
        <SessionPanel
          username={username}
          role={role}
          peers={offline ? [] : peers}
          offline={offline}
          onRename={saveName}
          onLeave={leave}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}

interface NamePromptProps {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

function NamePrompt({ initial, onSubmit, onCancel }: NamePromptProps) {
  const [value, setValue] = useState(initial);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(value);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal guest-name"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-name-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal__header">
          <div>
            <h2 className="modal__title" id="guest-name-title">
              Join live session
            </h2>
            <p className="modal__subtitle">
              Your name is shown next to your cursor. Drawings are end-to-end encrypted.
            </p>
          </div>
        </div>
        <div className="modal__body">
          <label className="guest-name__label" htmlFor="guest-name-input">
            Your name
          </label>
          <input
            id="guest-name-input"
            className="guest-name__input"
            autoFocus
            maxLength={MAX_NAME}
            value={value}
            placeholder="Guest"
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="modal__actions">
          <button type="submit" className="modal__primary">
            Join
          </button>
        </div>
      </form>
    </div>
  );
}

interface SessionPanelProps {
  username: string;
  role: Role;
  peers: CollabPeer[];
  offline: boolean;
  onRename: (name: string) => void;
  onLeave: () => void;
  onClose: () => void;
}

function SessionPanel({
  username,
  role,
  peers,
  offline,
  onRename,
  onLeave,
  onClose,
}: SessionPanelProps) {
  const [value, setValue] = useState(username);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onRename(value);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal guest-name"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-session-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <header className="modal__header">
          <div>
            <h2 className="modal__title" id="guest-session-title">
              Live session
            </h2>
            <p className="modal__subtitle">
              {offline
                ? "You're not connected. Edits here won't be shared."
                : "You joined as a guest. Drawings are end-to-end encrypted."}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn--icon-only"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="modal__body">
          {!offline && (
            <>
              <h3 className="guest-name__label">
                <UsersIcon /> In this session ({peers.length + 1})
              </h3>
              <ParticipantList selfName={username} selfRole={role} peers={peers} />
            </>
          )}
          <label className="guest-name__label" htmlFor="guest-session-name">
            Your name
          </label>
          <input
            id="guest-session-name"
            className="guest-name__input"
            maxLength={MAX_NAME}
            value={value}
            placeholder="Guest"
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="modal__actions">
          {!offline && (
            <button type="button" className="icon-btn icon-btn--danger" onClick={onLeave}>
              Leave session
            </button>
          )}
          <span className="spacer" />
          <button type="submit" className="modal__primary" disabled={value.trim() === username}>
            Save name
          </button>
        </div>
      </form>
    </div>
  );
}
