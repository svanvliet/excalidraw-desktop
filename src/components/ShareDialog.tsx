/**
 * Share dialog for live collaboration (docs/collab-protocol.md).
 *
 * - Collab toggle off → explains the feature and links to Settings. No
 *   network activity is possible from this state.
 * - No session → Start session (collab_start with the user's tunnel prefs).
 * - Hosting → relay/tunnel status with actionable errors, the share link,
 *   the local-only link, participant count, and Stop session.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CollabStatus } from "../ipc/commands";
import { selectLocalLink, selectShareLink, useCollabStore } from "../stores/collabStore";
import { useSettingsStore } from "../stores/settingsStore";
import { log } from "../lib/logger";
import { CloseIcon, CopyIcon } from "./icons";

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  /** Tab to share when starting a session. */
  tabId: string | null;
  onOpenSettings: () => void;
}

export function ShareDialog({ open, onClose, tabId, onOpenSettings }: ShareDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const collabEnabled = useSettingsStore((s) => s.collab);
  const tunnelMode = useSettingsStore((s) => s.collabTunnelMode);
  const manualUrl = useSettingsStore((s) => s.collabManualUrl);

  const status = useCollabStore((s) => s.status);
  const session = useCollabStore((s) => s.session);
  const starting = useCollabStore((s) => s.starting);
  const error = useCollabStore((s) => s.error);
  const shareLink = useCollabStore(selectShareLink);
  const localLink = useCollabStore(selectLocalLink);
  const startHosting = useCollabStore((s) => s.startHosting);
  const stopHosting = useCollabStore((s) => s.stopHosting);
  const leaveSession = useCollabStore((s) => s.leaveSession);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const hosting = session?.role === "host";
  const manualMissing = tunnelMode === "manual" && !manualUrl;

  let body: ReactNode;
  let actions: ReactNode;

  if (!collabEnabled) {
    body = (
      <p className="share__text" data-testid="share-disabled">
        Live collaboration is off. Turn it on in Settings to share this drawing with others. Changes
        and cursors are end-to-end encrypted, and a session only exists while you host it and this
        app is running.
      </p>
    );
    actions = (
      <button
        type="button"
        className="modal__primary"
        onClick={() => {
          onClose();
          onOpenSettings();
        }}
        data-testid="share-open-settings"
      >
        Open Settings
      </button>
    );
  } else if (session?.role === "guest") {
    body = (
      <p className="share__text" data-testid="share-guest">
        You&rsquo;re joined to someone else&rsquo;s session. Only the host can share it further.
      </p>
    );
    actions = (
      <button
        type="button"
        className="modal__danger"
        onClick={() => leaveSession()}
        data-testid="share-leave"
      >
        Leave session
      </button>
    );
  } else if (!hosting) {
    body = (
      <>
        <p className="share__text">
          Start a session to get a link others can open in a browser or in Excalidraw Desktop.
          Everything is end-to-end encrypted with a key that only exists in the link.
        </p>
        <p className="settings__hint">{modeDescription(tunnelMode, manualUrl)}</p>
        {manualMissing ? (
          <p className="settings__warning" role="note">
            Manual mode needs your tunnel&rsquo;s public URL. Add it in Settings first.
          </p>
        ) : null}
        {error ? (
          <p className="share__error" role="alert" data-testid="share-error">
            {error}
          </p>
        ) : null}
      </>
    );
    actions = (
      <>
        <button
          type="button"
          className="modal__secondary"
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
        >
          Settings
        </button>
        <button
          type="button"
          className="modal__primary"
          disabled={!tabId || starting || manualMissing}
          onClick={() => tabId && void startHosting(tabId)}
          data-testid="share-start"
        >
          {starting ? "Starting…" : "Start session"}
        </button>
      </>
    );
  } else {
    body = (
      <>
        {session.tabId !== tabId ? (
          <p className="settings__hint" data-testid="share-other-tab">
            This session is sharing a different tab.
          </p>
        ) : null}
        <dl className="share__status" data-testid="share-status">
          <dt>Relay</dt>
          <dd>{status.running ? `Running on ${status.localBase ?? "127.0.0.1"}` : "Starting…"}</dd>
          <dt>Tunnel</dt>
          <dd data-testid="share-tunnel-state">{tunnelLabel(status)}</dd>
          <dt>Participants</dt>
          <dd data-testid="share-peer-count">{status.peerCount}</dd>
        </dl>
        {status.tunnel.state === "error" && status.tunnel.error ? (
          <TunnelErrorHelp error={status.tunnel.error} />
        ) : null}
        {shareLink ? (
          <CopyField label="Share link" value={shareLink} testId="share-link" />
        ) : (
          <p className="settings__hint">The share link appears once the tunnel is ready.</p>
        )}
        {localLink && localLink !== shareLink ? (
          <CopyField
            label="This machine only"
            value={localLink}
            testId="share-local-link"
            hint="Works in a browser or second app instance on this computer."
          />
        ) : null}
        {error ? (
          <p className="share__error" role="alert" data-testid="share-error">
            {error}
          </p>
        ) : null}
      </>
    );
    actions = (
      <button
        type="button"
        className="icon-btn icon-btn--danger"
        onClick={() => void stopHosting()}
        data-testid="share-stop"
      >
        Stop session
      </button>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="share-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <div>
            <h2 id="share-title" className="modal__title">
              Live collaboration
            </h2>
            {hosting ? <p className="modal__subtitle">Session active</p> : null}
          </div>
          <button
            type="button"
            className="icon-btn icon-btn--icon-only"
            onClick={onClose}
            ref={closeRef}
            aria-label="Close"
            title="Close"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="modal__body share__body">{body}</div>
        <div className="modal__actions">
          <span className="spacer" />
          {actions}
        </div>
      </div>
    </div>
  );
}

function modeDescription(mode: string, manualUrl: string): string {
  switch (mode) {
    case "manual":
      return manualUrl
        ? `Manual tunnel: peers connect through ${manualUrl}.`
        : "Manual tunnel: no public URL configured.";
    case "local":
      return "Local only: the link works only on this machine.";
    default:
      return "Auto: a public HTTPS link is created with the devtunnel CLI on this machine.";
  }
}

function tunnelLabel(status: CollabStatus): string {
  const { mode, state } = status.tunnel;
  if (mode === "local") return "Local only (no tunnel)";
  switch (state) {
    case "starting":
      return "Starting…";
    case "ready":
      return mode === "manual" ? "Manual URL" : "Ready";
    case "error":
      return "Error";
    default:
      return "Off";
  }
}

export function TunnelErrorHelp({ error }: { error: string }) {
  let content: ReactNode;
  if (error === "devtunnel_not_installed") {
    content = (
      <>
        <strong>The devtunnel CLI isn&rsquo;t installed.</strong> Install it, then stop and start
        the session again:
        <code className="share__code">brew install --cask devtunnel</code>
        On Windows: <code className="share__code">winget install Microsoft.devtunnel</code>
        Or switch to Manual or Local in Settings.
      </>
    );
  } else if (error === "devtunnel_not_logged_in") {
    content = (
      <>
        <strong>devtunnel isn&rsquo;t signed in.</strong> Sign in once, then stop and start the
        session again:
        <code className="share__code">devtunnel user login</code>
      </>
    );
  } else if (error.startsWith("devtunnel_failed")) {
    const detail = error.slice("devtunnel_failed".length).replace(/^:\s*/, "");
    content = (
      <>
        <strong>Dev Tunnels failed to start.</strong> {detail || "Unknown error."} The local link
        below still works on this machine.
      </>
    );
  } else {
    content = (
      <>
        <strong>Tunnel error.</strong> {error}
      </>
    );
  }
  return (
    <div className="share__error" role="alert" data-testid="share-tunnel-error">
      {content}
    </div>
  );
}

function CopyField({
  label,
  value,
  testId,
  hint,
}: {
  label: string;
  value: string;
  testId: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch (e) {
      log.warn("share: clipboard write failed", e);
    }
  }, [value]);
  return (
    <div className="settings__field">
      <span>{label}</span>
      <div className="share__link-row">
        <input
          type="text"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          data-testid={testId}
          aria-label={label}
        />
        <button
          type="button"
          className="icon-btn"
          onClick={() => void copy()}
          data-testid={`${testId}-copy`}
        >
          <CopyIcon />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {hint ? <span className="settings__hint">{hint}</span> : null}
    </div>
  );
}
